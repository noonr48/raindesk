'use strict';

/**
 * Raindesk backend — node:http only, zero deps. Secure default is loopback
 * (127.0.0.1:17600). Remote binding is an explicit deployment choice and is
 * refused unless a long RAINDESK_REMOTE_TOKEN is configured. Wildcard binds
 * additionally require RAINDESK_ALLOW_WILDCARD=1 so a tailnet launch cannot
 * accidentally expose the creative workstation on every LAN interface.
 *
 * REST (JSON):
 *   GET  /api/board
 *   POST /api/board/move      { shotId | shot, lane }
 *   POST /api/gen             { shotId, layerId?, maskPng(b64), regionPng(b64),
 *                               prompt, seed?, negative? } -> { jobId }
 *   GET  /api/gen/{jobId}     -> { id, status, imageUrl? , error? }
 *   POST /api/blob            immutable content-addressed PNG upload
 *   GET  /api/blob/{sha}
 *   GET  /api/shot/{id}/document
 *   POST /api/shot/{id}/document  versioned editable shot document
 *   GET  /api/shot/{id}/revisions
 *   POST /api/shot/{id}/layer (legacy flattened PNG endpoint)
 *   GET  /api/shot/{id}/image/{file}
 *   GET  /api/direction       -> direction graph
 *   POST /api/direction/*     -> scene / shot / beat / annotation mutations
 *   POST /api/partner/turn    { message?, mode?, context? } -> structured partner turn
 *   GET/POST /api/workspace   persistent spatial board state
 *   GET/POST /api/partner/action/* permission-gated reversible actions
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
const crypto = require('crypto');
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
const blobs = require('./lib/blobs');
const shotDocuments = require('./lib/shot-documents');
const sheetDocuments = require('./lib/sheet-documents');
const workspace = require('./lib/workspace');
const workspaceV4 = require('./lib/workspace-v4');
const partnerActions = require('./lib/partner-actions');
const jobStore = require('./lib/job-store');
const takes = require('./lib/takes');

// Secure by default: remote/private-mesh exposure must be an explicit launch choice.
const HOST = process.env.RAINDESK_HOST || '127.0.0.1';
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
    'X-Content-Type-Options': 'nosniff',
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

/* --------------------------------------------------------- remote access */

function isLoopbackHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h);
}

function isWildcardHost(host) {
  const h = String(host || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === '0.0.0.0' || h === '::';
}

function validateBindOptions({ host, authToken, allowWildcard = false }) {
  if (isLoopbackHost(host)) return true;
  if (isWildcardHost(host) && !allowWildcard) {
    throw new Error('refusing wildcard network bind; use a specific trusted interface or set RAINDESK_ALLOW_WILDCARD=1');
  }
  // Explicit owner-directed opt-out (RAINDESK_REMOTE_UNPROTECTED=1): a private
  // LAN/private-mesh deployment may deliberately run with no access key so the
  // artist lands straight in the desk. Default remains token-required.
  if (process.env.RAINDESK_REMOTE_UNPROTECTED === '1') return true;
  if (typeof authToken !== 'string' || authToken.length < 24) {
    throw new Error('remote Raindesk requires RAINDESK_REMOTE_TOKEN with at least 24 characters');
  }
  return true;
}

function authCookieValue(token) {
  return crypto.createHash('sha256').update(`raindesk-session:${token}`).digest('hex');
}

function timingSafeTextEqual(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function cookieMap(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch (_e) { /* ignore malformed cookie */ }
  }
  return out;
}

function requestAuthorized(req, authToken) {
  if (!authToken) return true;
  const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  if (bearer && timingSafeTextEqual(bearer[1], authToken)) return true;
  const cookies = cookieMap(req.headers.cookie);
  return timingSafeTextEqual(cookies.raindesk_auth, authCookieValue(authToken));
}

/**
 * Host allowlist for mutations: the Host header must name an address this
 * server actually serves on (derived from the socket's own local address and
 * port, so loopback, LAN and wildcard deployments all work). This closes the
 * same-port DNS-rebinding class: a rebound hostname with a self-consistent
 * Origin still fails because evil.example is not a bound address.
 */
function hostAccepted(req) {
  const raw = String(req.headers.host || '').trim().toLowerCase();
  if (!raw) return false;
  const localPort = req.socket && Number(req.socket.localPort) || null;
  const localAddr = String((req.socket && req.socket.localAddress) || '').replace(/^::ffff:/i, '').toLowerCase();
  const allowed = new Set();
  const addHost = (h) => {
    if (!h) return;
    allowed.add(h);
    if (localPort) allowed.add(`${h}:${localPort}`);
  };
  addHost(localAddr);
  if (localAddr === '127.0.0.1' || localAddr === '::1' || localAddr === 'localhost') {
    addHost('localhost'); addHost('127.0.0.1'); addHost('[::1]');
  }
  // Owner-configured extra hostnames (comma-separated) — e.g. a LAN DNS
  // name or hosts-file alias used to reach this desk. The rebinding defense
  // is kept: an attacker controls the Host header, never this list.
  for (const extra of String(process.env.RAINDESK_ALLOWED_HOSTS || '').split(',')) {
    addHost(extra.trim().toLowerCase());
  }
  return allowed.has(raw);
}

/**
 * Local request boundary for the JSON API: a loopback creative server can
 * still be targeted from an unrelated page in the user's browser. The
 * content-type rule is method-gated (mutations must be JSON-shaped or the
 * multipart layer upload); the origin / fetch-site / Host rules run for
 * every /api/ request including reads — DNS-rebinding defense on read
 * routes too.
 */
function assertLocalMutationRequest(req, method) {
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const rawType = String(req.headers['content-type'] || '').trim().toLowerCase();
    if (rawType && !rawType.startsWith('application/json') && !rawType.startsWith('multipart/form-data')) {
      throw new HttpError(415, 'JSON APIs accept application/json bodies only');
    }
  }
  const origin = String(req.headers.origin || '').trim();
  if (origin) {
    let parsed;
    try { parsed = new URL(origin); } catch (_e) { throw new HttpError(403, 'bad Origin header'); }
    const host = String(req.headers.host || '');
    if (!host || parsed.host !== host) throw new HttpError(403, 'cross-origin API mutations are not accepted');
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').trim().toLowerCase();
  if (fetchSite === 'cross-site') {
    throw new HttpError(403, 'cross-site API mutations are not accepted');
  }
  if (!hostAccepted(req)) {
    throw new HttpError(403, 'Host header does not name a served address');
  }
}

function sendUnlockPage(res, status = 401, bad = false) {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Raindesk · unlock</title><style>body{font:16px system-ui;background:#111b20;color:#f3ead8;display:grid;place-items:center;min-height:100vh;margin:0}form{width:min(28rem,85vw);padding:2rem;border:1px solid #34505c;border-radius:18px;background:#17262d}input,button{box-sizing:border-box;width:100%;padding:.8rem 1rem;margin-top:.8rem;border-radius:10px;border:1px solid #45616c;background:#0f1b20;color:#f3ead8}button{cursor:pointer;background:#e8b04b;color:#182126;border:0;font-weight:700}.bad{color:#e07856}</style><form method="post" action="/__unlock"><h1>Raindesk</h1><p>This remote desk is private.</p>${bad ? '<p class="bad">That key did not match.</p>' : ''}<input type="password" name="token" autocomplete="current-password" placeholder="access key" required><button>open the desk</button></form>`;
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

/** Return true when auth handling already completed the response. */
async function handleRemoteAuth(req, res, url, authToken) {
  if (!authToken) return false;
  if (requestAuthorized(req, authToken)) return false;

  if (url.pathname === '/__unlock' && req.method === 'POST') {
    const buf = await readBody(req, 16 * 1024);
    const form = new URLSearchParams(buf.toString('utf8'));
    if (timingSafeTextEqual(form.get('token'), authToken)) {
      const cookie = encodeURIComponent(authCookieValue(authToken));
      res.writeHead(303, {
        Location: '/',
        'Set-Cookie': `raindesk_auth=${cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`,
        'Cache-Control': 'no-store',
      });
      res.end();
      return true;
    }
    sendUnlockPage(res, 401, true);
    return true;
  }

  if (url.pathname.startsWith('/api/')) {
    sendJson(res, 401, { error: 'Raindesk remote access key required' });
    return true;
  }
  sendUnlockPage(res, 401, false);
  return true;
}

/* ---------------------------------------------------------------- routes */

async function handleApi(req, res, url, deps) {
  const { queue, comfyImpl, agentImpl, partnerImpl } = deps;
  const route = url.pathname;
  const method = req.method;
  assertLocalMutationRequest(req, method);

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

  /* Spatial workspace: stable world-space objects shared by UI and Partner. */
  if (method === 'GET' && route === '/api/workspace') {
    return sendJson(res, 200, workspace.readClient());
  }
  /* STAGE-1 identity/intent protocol surface (GPT Pro round-6 STAGE-1
   * DESIGN). Typed conflict envelopes expose the machine-readable code plus
   * whatever canonical records the caller must adopt. */
  const v4Envelope = (res, error) => {
    const payload = { error: error.message };
    for (const key of ['code', 'tombstone', 'live', 'shelf', 'group']) {
      if (error[key] !== undefined) payload[key] = error[key];
    }
    return sendJson(res, error.status || 500, payload);
  };
  if (method === 'GET' && route === '/api/workspace/v4') {
    return sendJson(res, 200, workspaceV4.readV4());
  }
  if (method === 'POST' && route === '/api/workspace/v4/intents') {
    const body = await readJson(req, 64 * 1024);
    try {
      return sendJson(res, 200, workspaceV4.applyIntent(body));
    } catch (error) {
      if (error instanceof HttpError) return v4Envelope(res, error);
      throw error;
    }
  }
  const v4ReceiptMatch = route.match(/^\/api\/workspace\/v4\/intents\/([^/]+)\/([^/]+)$/);
  if (v4ReceiptMatch && method === 'GET') {
    const actorId = decodeSeg(v4ReceiptMatch[1]);
    const intentId = decodeSeg(v4ReceiptMatch[2]);
    if (actorId === null || intentId === null) throw new HttpError(404, 'not found');
    const receipt = workspaceV4.getReceipt(actorId, intentId);
    if (!receipt) throw new HttpError(404, 'no such intent receipt');
    return sendJson(res, 200, receipt);
  }
  const v4SpatialMatch = route.match(/^\/api\/workspace\/v4\/windows\/([^/]+)\/(\d+)\/spatial$/);
  if (v4SpatialMatch && method === 'PATCH') {
    const windowId = decodeSeg(v4SpatialMatch[1]);
    if (windowId === null) throw new HttpError(404, 'not found');
    const generation = Number.parseInt(v4SpatialMatch[2], 10);
    const body = await readJson(req, 64 * 1024);
    try {
      return sendJson(res, 200, workspaceV4.applySpatial(windowId, generation, body));
    } catch (error) {
      if (error instanceof HttpError) return v4Envelope(res, error);
      throw error;
    }
  }
  if (method === 'POST' && route === '/api/workspace/object') {
    const body = await readJson(req, 256 * 1024);
    // STAGE-1 tombstone guard: once the identity protocol has CLOSED a
    // logical id (tombstone + no live incarnation), ungated legacy upserts
    // must NOT resurrect it — the stale-tab resurrection race this program
    // exists to kill. Ids v4 has never tombstoned flow through unchanged.
    const legacyId = body && (typeof body.id === 'string' ? body.id : typeof body.windowId === 'string' ? body.windowId : null);
    if (legacyId !== null) {
      // Typed envelope even on the LEGACY route: a tombstone refusal is a
      // protocol conflict — the caller gets code + tombstone, not a bare 500.
      // BOTH client shapes are guarded: upsertObject maps id -> windowId, so
      // checking only body.id let {windowId:...} payloads resurrect rows.
      try { workspaceV4.assertLegacyWriteAllowed(legacyId); }
      catch (error) {
        if (error instanceof HttpError && error.code) return v4Envelope(res, error);
        throw error;
      }
    }
    // Revision rides along so freeform clients keep lastRevision in sync with
    // ungated upserts (each upsert bumps it; without adoption every later
    // gated structural write 409s).
    return sendJson(res, 200, { ok: true, object: workspace.upsertObject(body), revision: workspace.read().revision });
  }
  if (method === 'POST' && route === '/api/workspace/viewport') {
    const body = await readJson(req, 64 * 1024);
    return sendJson(res, 200, { ok: true, viewport: workspace.setViewport(body) });
  }
  /* Freeform desk structural API: groups, shelf, window deletion. These are
   * revision-gated (baseRevision -> 409 with the current workspace attached)
   * because a lost update here is structural, not spatial. */
  if (method === 'POST' && route === '/api/workspace/groups') {
    const body = await readJson(req, 256 * 1024);
    try {
      const ws = workspace.setGroups(body && body.groups, { baseRevision: body && body.baseRevision });
      return sendJson(res, 200, { ok: true, workspace: ws });
    } catch (error) {
      if (error instanceof HttpError && error.workspace) {
        return sendJson(res, error.status, { error: error.message, workspace: error.workspace });
      }
      throw error;
    }
  }
  if (method === 'POST' && route === '/api/workspace/shelf') {
    const body = await readJson(req, 64 * 1024);
    try {
      const ws = workspace.setShelf(body && body.windowIds, { baseRevision: body && body.baseRevision });
      return sendJson(res, 200, { ok: true, workspace: ws });
    } catch (error) {
      if (error instanceof HttpError && error.workspace) {
        return sendJson(res, error.status, { error: error.message, workspace: error.workspace });
      }
      throw error;
    }
  }
  if (method === 'POST' && route === '/api/workspace/window/delete') {
    const body = await readJson(req, 64 * 1024);
    try {
      const ws = workspace.deleteWindow(body && body.windowId, { baseRevision: body && body.baseRevision });
      return sendJson(res, 200, { ok: true, workspace: ws });
    } catch (error) {
      if (error instanceof HttpError && error.workspace) {
        return sendJson(res, error.status, { error: error.message, workspace: error.workspace });
      }
      throw error;
    }
  }

  /* Creative sheets: content is revisioned separately from world placement. */
  if (method === 'GET' && route === '/api/sheets') {
    return sendJson(res, 200, { sheets: sheetDocuments.list() });
  }
  if (method === 'POST' && route === '/api/sheet') {
    const body = await readJson(req, 256 * 1024);
    return sendJson(res, 201, { ok: true, revision: sheetDocuments.create(body || {}) });
  }
  const sheetCurrentMatch = route.match(/^\/api\/sheet\/([^/]+)$/);
  if (sheetCurrentMatch) {
    const sheetId = decodeSeg(sheetCurrentMatch[1]);
    if (sheetId === null) throw new HttpError(404, 'not found');
    if (method === 'GET') {
      const revision = sheetDocuments.readCurrent(sheetId);
      if (!revision) throw new HttpError(404, 'no such sheet');
      return sendJson(res, 200, revision);
    }
    if (method === 'POST') {
      const body = await readJson(req, 8 * 1024 * 1024);
      if (!body || !body.document) throw new HttpError(400, 'sheet document is required');
      const revision = sheetDocuments.save(sheetId, body.document, {
        baseRevisionId: body.baseRevisionId || null, reason: body.reason || 'edit sheet',
      });
      return sendJson(res, 200, { ok: true, revision });
    }
  }
  const sheetHistoryMatch = route.match(/^\/api\/sheet\/([^/]+)\/revisions$/);
  if (method === 'GET' && sheetHistoryMatch) {
    const sheetId = decodeSeg(sheetHistoryMatch[1]);
    if (sheetId === null) throw new HttpError(404, 'not found');
    return sendJson(res, 200, sheetDocuments.history(sheetId));
  }
  const sheetRevisionMatch = route.match(/^\/api\/sheet\/([^/]+)\/revision\/([^/]+)$/);
  if (method === 'GET' && sheetRevisionMatch) {
    const sheetId = decodeSeg(sheetRevisionMatch[1]); const revisionId = decodeSeg(sheetRevisionMatch[2]);
    if (sheetId === null || revisionId === null) throw new HttpError(404, 'not found');
    return sendJson(res, 200, sheetDocuments.readRevision(sheetId, revisionId));
  }
  const sheetRestoreMatch = route.match(/^\/api\/sheet\/([^/]+)\/revision\/([^/]+)\/restore$/);
  if (method === 'POST' && sheetRestoreMatch) {
    const sheetId = decodeSeg(sheetRestoreMatch[1]); const revisionId = decodeSeg(sheetRestoreMatch[2]);
    if (sheetId === null || revisionId === null) throw new HttpError(404, 'not found');
    const body = await readJson(req, 128 * 1024);
    return sendJson(res, 200, { ok: true, revision: sheetDocuments.restore(sheetId, revisionId, {
      baseRevisionId: body.baseRevisionId || null, reason: body.reason || 'restore sheet revision',
    }) });
  }

  if (method === 'GET' && route === '/api/partner/actions') {
    return sendJson(res, 200, { actions: partnerActions.list({ limit: Number(url.searchParams.get('limit')) || 100 }) });
  }
  const partnerActionMatch = route.match(/^\/api\/partner\/action\/([^/]+)\/(approve|execute|accept|revert|cancel)$/);
  if (method === 'POST' && partnerActionMatch) {
    const actionId = decodeSeg(partnerActionMatch[1]);
    if (actionId === null) throw new HttpError(404, 'not found');
    const verb = partnerActionMatch[2];
    const handlers = {
      approve: partnerActions.approve, execute: partnerActions.execute, accept: partnerActions.accept,
      revert: partnerActions.revert, cancel: partnerActions.cancel,
    };
    return sendJson(res, 200, { ok: true, action: handlers[verb](actionId) });
  }

  /* Direction Graph v2: structured production memory underneath the visual board. */
  if (method === 'GET' && route === '/api/direction') {
    return sendJson(res, 200, direction.readGraph());
  }

  if (method === 'POST' && route === '/api/direction/project') {
    const body = await readJson(req, 256 * 1024);
    return sendJson(res, 200, { ok: true, graph: direction.setProject(body) });
  }

  if (method === 'POST' && route === '/api/direction/scene') {
    const body = await readJson(req, 512 * 1024);
    return sendJson(res, 201, { ok: true, scene: direction.createScene(body) });
  }

  if (method === 'POST' && route === '/api/direction/shot') {
    const body = await readJson(req, 512 * 1024);
    return sendJson(res, 201, { ok: true, shot: direction.createShot(body) });
  }

  if (method === 'POST' && route === '/api/direction/beat') {
    const body = await readJson(req, 512 * 1024);
    return sendJson(res, 201, { ok: true, beat: direction.createBeat(body) });
  }

  if (method === 'POST' && route === '/api/direction/beat/update') {
    const body = await readJson(req, 512 * 1024);
    if (typeof body.beatId !== 'string' || !body.beatId) throw new HttpError(400, 'beatId is required');
    return sendJson(res, 200, { ok: true, beat: direction.updateBeat(body.beatId, body.patch || {}) });
  }

  if (method === 'POST' && route === '/api/direction/beat/reorder') {
    const body = await readJson(req, 512 * 1024);
    if (typeof body.shotId !== 'string' || !body.shotId) throw new HttpError(400, 'shotId is required');
    return sendJson(res, 200, { ok: true, beats: direction.reorderBeats(body.shotId, body.orderedBeatIds) });
  }

  if (method === 'POST' && route === '/api/direction/beat/delete') {
    const body = await readJson(req, 128 * 1024);
    if (typeof body.beatId !== 'string' || !body.beatId) throw new HttpError(400, 'beatId is required');
    return sendJson(res, 200, { ok: true, ...direction.deleteBeat(body.beatId) });
  }

  if (method === 'POST' && route === '/api/direction/shot-constraints') {
    const body = await readJson(req, 512 * 1024);
    if (typeof body.shotId !== 'string' || !body.shotId) throw new HttpError(400, 'shotId is required');
    return sendJson(res, 200, { ok: true, shotId: body.shotId, constraints: direction.setShotConstraints(body.shotId, body) });
  }

  if (method === 'POST' && route === '/api/direction/beat-frame-ref') {
    const body = await readJson(req, 1024 * 1024);
    if (typeof body.beatId !== 'string' || !body.beatId) throw new HttpError(400, 'beatId is required');
    if (typeof body.slot !== 'string' || !body.slot) throw new HttpError(400, 'slot is required');
    const frameRef = direction.setBeatFrameRef(body.beatId, body.slot, body.frameRef == null ? null : body.frameRef);
    return sendJson(res, 200, { ok: true, beatId: body.beatId, slot: body.slot, frameRef });
  }

  if (method === 'POST' && route === '/api/direction/annotation') {
    const body = await readJson(req, 1024 * 1024);
    return sendJson(res, 201, { ok: true, annotation: direction.addAnnotation(body) });
  }

  if (method === 'POST' && route === '/api/direction/shot-anchor') {
    const body = await readJson(req, 1024 * 1024);
    if (typeof body.shotId !== 'string' || !body.shotId) throw new HttpError(400, 'shotId is required');
    if (typeof body.slot !== 'string' || !body.slot) throw new HttpError(400, 'slot is required');
    const anchor = direction.setShotAnchor(body.shotId, body.slot, body.anchor == null ? null : body.anchor);
    return sendJson(res, 200, { ok: true, shotId: body.shotId, slot: body.slot, anchor });
  }

  if (method === 'POST' && route === '/api/direction/shot-frame-ref') {
    const body = await readJson(req, 1024 * 1024);
    if (typeof body.shotId !== 'string' || !body.shotId) throw new HttpError(400, 'shotId is required');
    if (typeof body.slot !== 'string' || !body.slot) throw new HttpError(400, 'slot is required');
    const frameRef = direction.setShotFrameRef(body.shotId, body.slot, body.frameRef == null ? null : body.frameRef);
    return sendJson(res, 200, { ok: true, shotId: body.shotId, slot: body.slot, frameRef });
  }

  const directionSpecMatch = route.match(/^\/api\/direction\/shot\/([^/]+)\/spec$/);
  if (method === 'GET' && directionSpecMatch) {
    const shotId = decodeSeg(directionSpecMatch[1]);
    if (shotId === null) throw new HttpError(404, 'not found');
    return sendJson(res, 200, direction.shotSpec(shotId));
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
    // Generation inputs are creative provenance too. Store the exact source
    // crop and mask before queueing so a future take can always explain what
    // it was derived from, even after the live canvas moves on.
    const sourceRegionAsset = blobs.putPng(imageBuffer);
    const maskAsset = blobs.putPng(maskBuffer);
    const baseRevisionId = typeof body.baseRevisionId === 'string' ? body.baseRevisionId.slice(0, 160) : null;
    const region = body.region && typeof body.region === 'object' ? body.region : null;
    const lasso = Array.isArray(body.lasso) ? body.lasso : [];

    const jobId = queue.submit(async ({ setPhase, jobId: runningJobId } = {}) => {
      if (setPhase) setPhase('generating');
      const result = await comfyImpl.runInpaint({
        shotId, layerId, prompt, negative: negative || '', seed,
        imageBuffer, maskBuffer,
      });

      // A generation is not considered safely finished until its output is
      // mirrored into Raindesk's immutable blob store. This prevents a take
      // from pointing only at ComfyUI's ephemeral/local URL.
      if (setPhase) setPhase('mirroring');
      if (!comfyImpl.fetchImageBytes || !result || !Array.isArray(result.images) || !result.images[0]) {
        throw new Error('generation completed but its output could not be mirrored safely');
      }
      const bytes = await comfyImpl.fetchImageBytes(result.images[0]);
      validatePngBuffer(bytes, 'generated output');
      const resultAsset = blobs.putPng(bytes);
      const take = takes.createCandidate({
        shotId, jobId: runningJobId, prompt, negative: negative || '', seed,
        baseRevisionId, sourceRegionAssetSha: sourceRegionAsset.sha,
        maskAssetSha: maskAsset.sha, resultAssetSha: resultAsset.sha,
        region, lasso,
      });
      return {
        ...result,
        imageUrl: `/api/blob/${resultAsset.sha}`,
        comfyUrl: result.imageUrl,
        takeId: take.id,
        resultAssetSha: resultAsset.sha,
      };
    }, {
      shotId, layerId: layerId || null, baseRevisionId,
      sourceRegionAssetSha: sourceRegionAsset.sha, maskAssetSha: maskAsset.sha, region,
    });
    return sendJson(res, 200, { jobId });
  }

  const genCancelMatch = route.match(/^\/api\/gen\/([^/]+)\/cancel$/);
  if (method === 'POST' && genCancelMatch) {
    const id = decodeSeg(genCancelMatch[1]);
    if (id === null) throw new HttpError(404, 'not found');
    const cancelled = queue.cancel(id);
    if (!cancelled.ok) {
      if (cancelled.reason === 'not_found') throw new HttpError(404, 'no such job');
      if (cancelled.reason === 'running') throw new HttpError(409, 'generation is already running and cannot be safely cancelled yet');
      throw new HttpError(409, 'generation is already settled');
    }
    return sendJson(res, 200, { ok: true, job: queue.view(cancelled.job) });
  }

  if (method === 'GET' && route === '/api/jobs') {
    return sendJson(res, 200, {
      jobs: jobStore.list({ shotId: url.searchParams.get('shotId') || null, limit: Number(url.searchParams.get('limit')) || 100 }),
    });
  }

  const genMatch = route.match(/^\/api\/gen\/([^/]+)$/);
  if (method === 'GET' && genMatch) {
    const seg = decodeSeg(genMatch[1]);
    const job = seg === null ? null : (queue.get(seg) || jobStore.get(seg));
    if (!job) throw new HttpError(404, 'no such job');
    return sendJson(res, 200, queue.view(job));
  }

  if (method === 'GET' && route === '/api/takes') {
    return sendJson(res, 200, {
      takes: takes.list({
        shotId: url.searchParams.get('shotId') || null,
        status: url.searchParams.get('status') || null,
        limit: Number(url.searchParams.get('limit')) || 200,
      }),
    });
  }

  const takeStatusMatch = route.match(/^\/api\/take\/([^/]+)\/(accept|reject|reopen)$/);
  if (method === 'POST' && takeStatusMatch) {
    const id = decodeSeg(takeStatusMatch[1]);
    if (id === null) throw new HttpError(404, 'not found');
    const body = await readJson(req, 64 * 1024);
    const status = takeStatusMatch[2] === 'accept' ? 'accepted'
      : (takeStatusMatch[2] === 'reopen' ? 'candidate' : 'rejected');
    const updated = takes.setStatus(id, status, { revisionId: body.revisionId || null });
    return sendJson(res, 200, { ok: true, take: updated });
  }

  const assetMatch = route.match(/^\/api\/assets\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9._-]{1,128})$/);
  if (method === 'GET' && assetMatch) {
    const filePath = assets.resolve(assetMatch[1], assetMatch[2]);
    if (!filePath) throw new HttpError(404, 'no such asset');
    let stat;
    try { stat = await fs.promises.stat(filePath); } catch (_e) { throw new HttpError(404, 'no such asset'); }
    if (!stat.isFile()) throw new HttpError(404, 'no such asset');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': stat.size });
    await pipeline(fs.createReadStream(filePath), res);
    return;
  }

  if (method === 'POST' && route === '/api/blob') {
    const contentType = String(req.headers['content-type'] || '');
    if (!/multipart\/form-data/i.test(contentType)) throw new HttpError(400, 'expected multipart/form-data');
    const buf = await readBody(req, UPLOAD_BODY_LIMIT);
    const parts = parseMultipart(buf, contentType);
    const filePart = parts.find((p) => p.filename) || parts.find((p) => p.name === 'file' || p.name === 'image');
    if (!filePart || !filePart.body.length) throw new HttpError(400, 'no file part in upload');
    return sendJson(res, 200, blobs.putPng(filePart.body));
  }

  const blobMatch = route.match(/^\/api\/blob\/([a-f0-9]{64})$/);
  if (method === 'GET' && blobMatch) {
    const filePath = blobs.resolve(blobMatch[1]);
    if (!filePath) throw new HttpError(404, 'no such blob');
    const stat = await fs.promises.stat(filePath);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': stat.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'ETag': `"${blobMatch[1]}"`,
    });
    await pipeline(fs.createReadStream(filePath), res);
    return undefined;
  }

  const documentMatch = route.match(/^\/api\/shot\/([^/]+)\/document$/);
  if (documentMatch) {
    const shotId = decodeSeg(documentMatch[1]);
    if (shotId === null) throw new HttpError(404, 'not found');
    if (method === 'GET') {
      const current = shotDocuments.readCurrent(shotId);
      if (!current) throw new HttpError(404, 'no editable shot document');
      return sendJson(res, 200, current);
    }
    if (method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024);
      if (!body || typeof body.document !== 'object') throw new HttpError(400, 'document is required');
      const saved = shotDocuments.save(shotId, body.document, {
        baseRevisionId: body.baseRevisionId || null,
        reason: body.reason || 'edit',
      });
      return sendJson(res, 200, saved);
    }
  }

  const revisionsMatch = route.match(/^\/api\/shot\/([^/]+)\/revisions$/);
  if (method === 'GET' && revisionsMatch) {
    const shotId = decodeSeg(revisionsMatch[1]);
    if (shotId === null) throw new HttpError(404, 'not found');
    return sendJson(res, 200, shotDocuments.list(shotId));
  }

  const revisionMatch = route.match(/^\/api\/shot\/([^/]+)\/revision\/([^/]+)$/);
  if (method === 'GET' && revisionMatch) {
    const shotId = decodeSeg(revisionMatch[1]);
    const revisionId = decodeSeg(revisionMatch[2]);
    if (shotId === null || revisionId === null) throw new HttpError(404, 'not found');
    return sendJson(res, 200, shotDocuments.readRevision(shotId, revisionId));
  }

  const restoreMatch = route.match(/^\/api\/shot\/([^/]+)\/revision\/([^/]+)\/restore$/);
  if (method === 'POST' && restoreMatch) {
    const shotId = decodeSeg(restoreMatch[1]);
    const revisionId = decodeSeg(restoreMatch[2]);
    if (shotId === null || revisionId === null) throw new HttpError(404, 'not found');
    const body = await readJson(req, 64 * 1024);
    const restored = shotDocuments.restore(shotId, revisionId, {
      baseRevisionId: body.baseRevisionId || null,
      reason: body.reason || 'restore revision',
    });
    return sendJson(res, 201, restored);
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
    }
    chatInFlight += 1;
    let result;
    try {
      const body = await readJson(req, 1024 * 1024);
      const message = body.message == null ? '' : body.message;
      if (typeof message !== 'string') throw new HttpError(400, 'message must be a string');
      if (message.length > CHAT_MESSAGE_LIMIT) throw new HttpError(413, 'message too long');
      if (!message.trim() && body.mode !== 'kickstart') {
        throw new HttpError(400, 'message is required unless mode is kickstart');
      }
      if (body.context !== undefined && (!body.context || typeof body.context !== 'object' || Array.isArray(body.context))) {
        throw new HttpError(400, 'context must be an object');
      }
      result = await partnerImpl.turn({
        message,
        mode: body.mode || null,
        context: body.context || {},
      });
    } finally {
      chatInFlight -= 1;
    }
    return sendJson(res, 200, result);
  }

  if (method === 'POST' && route === '/api/chat') {
    if (chatInFlight >= CHAT_CONCURRENCY) {
      throw new HttpError(429, 'companion is talking with you already — one moment 🌧️');
    }
    // Increment BEFORE the awaited readJson so the check-then-act window
    // cannot admit unbounded concurrent spawns; the finally balances every
    // post-increment path including body-validation throws.
    chatInFlight += 1;
    let reply;
    try {
      const body = await readJson(req, 1024 * 1024);
      if (typeof body.message !== 'string' || !body.message.trim()) {
        throw new HttpError(400, 'message is required');
      }
      if (body.message.length > CHAT_MESSAGE_LIMIT) {
        throw new HttpError(413, 'message too long');
      }
      reply = await agentImpl.chat(body.message);
    } finally {
      chatInFlight -= 1;
    }
    return sendJson(res, 200, { reply });
  }

  throw new HttpError(404, 'not found');
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    throw new HttpError(404, 'not found');
  }
  let rel = url.pathname;
  if (rel === '/') rel = '/index.html';
  const filePath = safePublicPath(rel);
  if (!filePath) throw new HttpError(404, 'not found');

  let stat;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (_e) {
    throw new HttpError(404, 'not found');
  }
  if (!stat.isFile()) throw new HttpError(404, 'not found');

  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  await pipeline(fs.createReadStream(filePath), res);
  return undefined;
}

/* ---------------------------------------------------------------- server */

function createServer(deps = {}) {
  const queue = deps.queue || new GenQueue({ store: jobStore });
  const comfyImpl = deps.comfyImpl || deps.comfy || comfy;
  const agentImpl = deps.agentImpl || deps.agent || agent;
  const partnerImpl = deps.partnerImpl || partner.createPartner({ agentImpl });
  const authToken = deps.authToken || null;

  const server = http.createServer((req, res) => {
    let promise;
    try {
      const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
      promise = (async () => {
        if (await handleRemoteAuth(req, res, url, authToken)) return undefined;
        return url.pathname.startsWith('/api/')
          ? handleApi(req, res, url, { queue, comfyImpl, agentImpl, partnerImpl })
          : serveStatic(req, res, url);
      })();
    } catch (_e) {
      promise = Promise.reject(new HttpError(404, 'not found'));
    }
    promise.catch((e) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : 'internal error';
      if (!(e instanceof HttpError)) {
        // eslint-disable-next-line no-console
        console.error('[raindesk] unhandled error:', e);
      }
      try {
        sendJson(res, status, { error: message }); // res may be destroyed (413 path)
      } catch (_sendErr) {
        res.destroy();
      }
    });
  });
  server.raindesk = { queue, comfyImpl, agentImpl, partnerImpl, authToken: Boolean(authToken) };
  return server;
}

function start({
  host = HOST,
  port = PORT,
  authToken = process.env.RAINDESK_REMOTE_TOKEN || null,
  allowWildcard = process.env.RAINDESK_ALLOW_WILDCARD === '1',
} = {}) {
  return new Promise((resolve, reject) => {
    try {
      validateBindOptions({ host, authToken, allowWildcard });
      jobStore.recoverInterrupted();
    } catch (e) {
      reject(e);
      return;
    }
    const server = createServer({ authToken: isLoopbackHost(host) ? null : authToken });
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      // eslint-disable-next-line no-console
      console.log(`[raindesk] listening on http://${addr.address}:${addr.port}`);
      resolve(server);
    });
  });
}

if (require.main === module) {
  start().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[raindesk] failed to start:', e);
    process.exit(1);
  });
}

module.exports = {
  createServer, start, HOST, PORT, PUBLIC_DIR, parseMultipart, safePublicPath, sendJson,
  isLoopbackHost, isWildcardHost, validateBindOptions, authCookieValue, requestAuthorized, hostAccepted,
};
