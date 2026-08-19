'use strict';

/** Immutable content-addressed MP4 storage + single-range serving. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const ROOT = path.join(DATA_DIR, 'animatic', 'artifacts');
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_MP4_BYTES = 1024 * 1024 * 1024; // 1 GiB v1 safety ceiling.

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function assertSha(value) {
  const sha = typeof value === 'string' ? value.trim() : '';
  if (!SHA_RE.test(sha)) throw new HttpError(400, 'bad video artifact sha');
  return sha;
}

function artifactPath(sha) { return path.join(ROOT, `${assertSha(sha)}.mp4`); }

function looksLikeMp4(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= 12 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
}

function putMp4(bytes, { expectedSha = null, expectedBytes = null } = {}) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) throw new HttpError(422, 'candidate MP4 is empty or malformed');
  if (bytes.length > MAX_MP4_BYTES) throw new HttpError(413, 'candidate MP4 exceeds the v1 size limit');
  if (!looksLikeMp4(bytes)) throw new HttpError(422, 'candidate artifact is not an MP4 container');
  const sha = sha256(bytes);
  if (expectedSha && sha !== assertSha(expectedSha)) throw new HttpError(422, 'candidate MP4 hash does not match its manifest');
  if (expectedBytes != null && Number(expectedBytes) !== bytes.length) throw new HttpError(422, 'candidate MP4 byte count does not match its manifest');

  fs.mkdirSync(ROOT, { recursive: true });
  const target = artifactPath(sha);
  if (fs.existsSync(target)) {
    const existing = fs.readFileSync(target);
    if (sha256(existing) !== sha || existing.length !== bytes.length) throw new HttpError(500, `stored video artifact ${sha} failed integrity verification`);
    return { sha, bytes: bytes.length, mimeType: 'video/mp4', path: target };
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  try { fs.renameSync(tmp, target); }
  catch (error) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* concurrent writer may have won */ }
    if (!fs.existsSync(target)) throw error;
    const existing = fs.readFileSync(target);
    if (sha256(existing) !== sha || existing.length !== bytes.length) throw error;
  }
  return { sha, bytes: bytes.length, mimeType: 'video/mp4', path: target };
}

function stat(sha) {
  const file = artifactPath(sha);
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) throw new Error('not file');
    return { sha: assertSha(sha), bytes: info.size, mimeType: 'video/mp4', path: file };
  } catch (_error) {
    throw new HttpError(404, 'no such video artifact');
  }
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) throw new HttpError(416, 'unsupported video range');
  let start;
  let end;
  if (match[1] === '' && match[2] === '') throw new HttpError(416, 'empty video range');
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) throw new HttpError(416, 'bad video range');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    throw new HttpError(416, 'video range is outside the artifact');
  }
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

function serve(req, res, sha) {
  const item = stat(sha);
  let range;
  try { range = parseRange(req.headers && req.headers.range, item.bytes); }
  catch (error) {
    if (error instanceof HttpError && error.status === 416) {
      res.writeHead(416, { 'Content-Range': `bytes */${item.bytes}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return;
    }
    throw error;
  }
  const headers = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=31536000, immutable',
  };
  if (!range) {
    headers['Content-Length'] = item.bytes;
    res.writeHead(200, headers);
    fs.createReadStream(item.path).pipe(res);
    return;
  }
  headers['Content-Length'] = range.length;
  headers['Content-Range'] = `bytes ${range.start}-${range.end}/${item.bytes}`;
  res.writeHead(206, headers);
  fs.createReadStream(item.path, { start: range.start, end: range.end }).pipe(res);
}

module.exports = {
  DATA_DIR, ROOT, SHA_RE, MAX_MP4_BYTES,
  sha256, assertSha, artifactPath, looksLikeMp4, putMp4, stat, parseRange, serve,
};
