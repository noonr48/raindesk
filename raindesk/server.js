'use strict';

/**
 * Raindesk backend — node:http only, zero deps. Binds all interfaces
 * (0.0.0.0:17600 by default, override with RAINDESK_HOST) so the owner's
 * phone/laptop reach it over the tailnet — same exposure model as the
 * estate's vault-app. Unauthenticated by design: trusted home network only.
 *
 * REST (JSON):
 *   GET  /api/board
 *   POST /api/board/move      { shotId | shot, lane }
 *   POST /api/gen             { shotId, layerId?, maskPng(b64), regionPng(b64),
 *                               prompt, seed?, negative? } -> { jobId }
 *   GET  /api/gen/{jobId}     -> { id, status, imageUrl? , error? }
 *   POST /api/shot/{id}/layer (multipart PNG ≤20MB, field "image"|"file")
 *   GET  /api/shot/{id}/image/{file}
 *   GET  /api/direction       -> direction graph
 *   POST /api/direction/*     -> scene / shot / beat / annotation mutations
 *   POST /api/partner/turn    { message?, mode?, context? } -> structured partner turn
 *   POST /api/chat            { message } -> { reply } (legacy companion route)
 *
 * Static: public/ with MIME map, path-traversal-proof (normalize + prefix).
 * Safety: no shell anywhere (pi gets argv/stdin, ComfyUI gets
 * JSON/multipart); PNG magic + size validated on every upload; generation
 * serialized one-at-a-time by lib/queue.js; chat caps concurrent pi spawns
 * (bounds resource use on the trusted network — not a hard security limit).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');

const { HttpError } = require('./lib/errors');
const board = require('./lib/board');
const shots = require('./lib/shots');
const { validatePngBuffer, MAX_PNG_BYTES } = require('./lib/validate');
const comfy = require('./lib/comfy');
const agent = require('./lib/agent');
const direction = require('./lib/direction');
const partner = require('./lib/partner');
const { GenQueue } = require('./lib/queue');
const assets = require('./lib/assets');

const HOST = process.env.RAINDESK_HOST || '0.0.0.0'; // tailnet-reachable (phone/laptop); vault-app/mockup precedent
const PORT = 17600;

const PUBLIC_DIR = path.join(__dirname, 'public');
// Two ≤20MB PNGs travel base64 in one JSON body (~27MB each decoded-then-encoded).
const JSON_BODY_LIMIT = 64 * 1024 * 1024;
const UPLOAD_BODY_LIMIT = MAX_PNG_BYTES + 1024 * 1024; // PNG + multipart overhead
const CHAT_MESSAGE_LIMIT = 16 * 1024;
const CHAT_CONCURRENCY = 3; // each chat spawns a pi process — cap concurrent spawns
let chatInFlight = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

/* ---------------------------------------------------------------- helpers */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        // Keep the socket alive so the 413 can be sent; later chunks drain.
        reject(new HttpError(413, `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
  });
}

async function readJson(req, limit = JSON_BODY_LIMIT) {
  const buf = await readBody(req, limit);
  if (!buf.length) throw new HttpError(400, 'empty request body');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (_e) {
    throw new HttpError(400, 'request body is not valid JSON');
  }
}

function decodeBase64Png(value, what) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${what} is required (base64 PNG)`);
  }
  return Buffer.from(value.replace(/\s+/g, ''), 'base64');
}

/** Decode one URL path segment; null on malformed percent-encoding. */
function decodeSeg(seg) {
  try {
    return decodeURIComponent(seg);
  } catch (_e) {
    return null;
  }
}

/** Minimal multipart/form-data parser for single-file uploads (no deps). */
function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw new HttpError(400, 'multipart boundary missing');
  const boundary = `--${(m[1] || m[2]).trim()}`;
  const bBuf = Buffer.from(boundary, 'utf8');

  const parts = [];
  let idx = buffer.indexOf(bBuf);
  while (idx !== -1) {
    const next = buffer.indexOf(bBuf, idx + bBuf.length);
    if (next === -1) break;
    let start = idx + bBuf.length;
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2;
    const end = next - 2; // strip the \r\n that precedes the boundary
    const part = buffer.subarray(start, end);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1) {
      const headerText = part.subarray(0, split).toString('utf8');
      const body = part.subarray(split + 4);
      const nameMatch = /name="([^"]*)"/i.exec(headerText);
      const fileMatch = /filename="([^"]*)"/i.exec(headerText);
      parts.push({
        name: nameMatch ? nameMatch[1] : '',
        filename: fileMatch ? fileMatch[1] : undefined,
        body,
      });
    }
    idx = next;
  }
  return parts;
}

/** Resolve a URL path inside PUBLIC_DIR; null when it escapes the root. */
function safePublicPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_e) {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const resolved = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) return null;
  return resolved;
}

/* ---------------------------------------------------------------- routes */

async function handleApi(req, res, url, deps) {
  const { queue, comfyImpl, agentImpl, partnerImpl } = deps;
  const route = url.pathname;
  const method = req.method;

  if (method === 'GET' && route === '/api/board') {
    return sendJson(res, 200, board.readBoard());
  }

  if (method === 'POST' && route === '/api/board/move') {
    const body = await readJson(req, 64 * 1024);
    const shotId = body.shotId ?? body.shot; // brief says {shot}, task says {shotId}
    if (typeof shotId !== 'string' || !shotId) throw new HttpError(400, 'shotId is required');
    if (typeof body.lane !== 'string' || !body.lane) throw new HttpError(400, 'lane is required');
    const updated = board.moveShot(shotId, body.lane);
    return sendJson(res, 200, { ok: true, board: updated });
  }

  /* Direction Graph v2: structured production memory underneath the visual board. */
  if (method === 'GET' && route === '/api/direction') {
    return sendJson(res, 200, direction.readGraph());
  }

  if (method === 'POST' && route === '/api/direction/project') {
    const body = await readJson(req, 256 * 1024);
    const graph = direction.setProject(body);
    return sendJson(res, 200, { ok: true, graph });
  }

  if (method === 'POST' && route === '/api/direction/scene') {
    const body = await readJson(req, 1024 * 1024);
    const scene = direction.createScene(body);
    return sendJson(res, 200, { ok: true, scene, graph: direction.readGraph() });
  }

  if (method === 'POST' && route === '/api/direction/shot') {
    const body = await readJson(req, 1024 * 1024);
    const shot = direction.createShot(body);
    return sendJson(res, 200, { ok: true, shot, graph: direction.readGraph() });
  }

  if (method === 'POST' && route === '/api/direction/beat') {
    const body = await readJson(req, 1024 * 1024);
    const beat = direction.createBeat(body);
    return sendJson(res, 200, { ok: true, beat, graph: direction.readGraph() });
  }

  if (method === 'POST' && route === '/api/direction/annotation') {
    const body = await readJson(req, 2 * 1024 * 1024);
    const annotation = direction.addAnnotation(body);
    return sendJson(res, 200, { ok: true, annotation, graph: direction.readGraph() });
  }

  if (method === 'POST' && route === '/api/gen') {
    const body = await readJson(req);
    if (typeof body.shotId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.shotId)) {
      throw new HttpError(400, 'shotId is required ([A-Za-z0-9_-], 1-64 chars)');
    }
    if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
      throw new HttpError(400, 'prompt is required');
    }
    const imageBuffer = decodeBase64Png(body.regionPng, 'regionPng');
    const maskBuffer = decodeBase64Png(body.maskPng, 'maskPng');
    validatePngBuffer(imageBuffer, 'regionPng'); // fast 400/413 before queueing
    validatePngBuffer(maskBuffer, 'maskPng');
    if (body.seed !== undefined) comfy.normalizeSeed(body.seed); // validate now

    const { shotId, layerId, prompt, negative, seed } = body;
    const jobId = queue.submit(async () => {
      const result = await comfyImpl.runInpaint({
        shotId, layerId, prompt, negative: negative || '', seed,
        imageBuffer, maskBuffer,
      });
      // Phone-safe delivery: mirror the output into Raindesk's same-origin
      // asset store so clients never need to reach ComfyUI's 127.0.0.1 URL
      // (which is client-local and broken on any non-localhost device).
      try {
        if (comfyImpl.fetchImageBytes && result && Array.isArray(result.images) && result.images[0]) {
          const bytes = await comfyImpl.fetchImageBytes(result.images[0]);
          const stored = assets.store(shotId, bytes);
          return { ...result, imageUrl: stored.url, comfyUrl: result.imageUrl };
        }
      } catch (_e) { /* fall back to the ComfyUI URL */ }
      return result;
    }, { shotId, layerId: layerId || null });
    return sendJson(res, 200, { jobId });
  }

  const genMatch = route.match(/^\/api\/gen\/([^/]+)$/);
  if (method === 'GET' && genMatch) {
    const seg = decodeSeg(genMatch[1]);
    const job = seg === null ? null : queue.get(seg);
    if (!job) throw new HttpError(404, 'no such job');
    return sendJson(res, 200, queue.view(job));
  }

  const assetMatch = route.match(/^\/api\/assets\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]{1,128})$/);
  if (method === 'GET' && assetMatch) {
    const filePath = assets.resolve(assetMatch[1], assetMatch[2]);
    if (!filePath) throw new HttpError(404, 'nopsuch asset');
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch (_e) { throw new HttpError(404, 'nosuch asset'); }
    if (!stat.isFile()) throw new HttpError(404, 'nosuch asset');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size });
    await pipeline(fs.createReadStream(filePath), res);
    return;
  }

  const shotMatch = route.match(/^\/api\/shot\/([^/]+)$/);
  if (method === 'GET' && shotMatch) {
    let shot;
    try {
      shot = shots.readShot(decodeURIComponent(shotMatch[1]));
    } catch (_e) {
      throw new HttpError(400, 'bad shot id');
    }
    return sendJson(res, 200, shot);
  }

  const layerMatch = route.match(/^\/api\/shot\/([^/]+)\/layer$/);
  if (method === 'POST' && layerMatch) {
    const shotId = decodeSeg(layerMatch[1]);
    if (shotId === null) throw new HttpError(404, 'not found');
    const contentType = String(req.headers['content-type'] || '');
    if (!/multipart\/form-data/i.test(contentType)) {
      throw new HttpError(400, 'expected multipart/form-data');
    }
    const buf = await readBody(req, UPLOAD_BODY_LIMIT);
    const parts = parseMultipart(buf, contentType);
    const filePart = parts.find((p) => p.filename) || parts.find((p) => p.name === 'file' || p.name === 'image');
    if (!filePart || !filePart.body.length) throw new HttpError(400, 'no file part in upload');
    const saved = shots.saveLayer(shotId, filePart.body);
    return sendJson(res, 200, { ok: true, shotId, file: saved.file, url: saved.url, ts: saved.ts });
  }

  const imageMatch = route.match(/^\/api\/shot\/([^/]+)\/image\/([^/]+)$/);
  if (method === 'GET' && imageMatch) {
    const shotId = decodeSeg(imageMatch[1]);
    const file = shotId === null ? null : decodeSeg(imageMatch[2]);
    if (file === null) throw new HttpError(404, 'not found');
    const filePath = shots.layerPath(shotId, file);
    if (!filePath) throw new HttpError(404, 'not found');
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch (_e) {
      throw new HttpError(404, 'not found');
    }
    if (!stat.isFile()) throw new HttpError(404, 'not found');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    await pipeline(fs.createReadStream(filePath), res);
    return undefined;
  }

  if (method === 'POST' && route === '/api/partner/turn') {
    if (chatInFlight >= CHAT_CONCURRENCY) {
                  throw new HttpError(429, 'partner is already thinking with you - one moment');