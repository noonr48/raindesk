'use strict';

/**
 * Same-origin asset store: generated outputs are mirrored out of ComfyUI into
 * Raindesk's own data dir and served from /api/assets/... — a phone (or any
 * non-localhost client) can then load takes without reaching ComfyUI itself
 * (127.0.0.1:8188 URLs are client-local and phone-broken).
 */

const fs = require('fs');
const path = require('path');

const ASSETS_DIR = process.env.RAINDESK_DATA_DIR
  ? path.join(path.resolve(process.env.RAINDESK_DATA_DIR), 'assets')
  : path.join(__dirname, '..', 'data', 'assets');

function safeSeg(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : null;
}

/** Store a buffer for a shot; returns { file, url } (same-origin URL). */
function store(shotId, buffer, ext = 'png') {
  const seg = safeSeg(shotId);
  if (!seg) throw new Error('bad asset shot id');
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) throw new Error('bad asset bytes');
  const dir = path.join(ASSETS_DIR, seg);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  return { file, url: `/api/assets/${seg}/${file}` };
}

/** Resolve a (shotId, file) pair to an absolute path inside the store, or null. */
function resolve(shotId, file) {
  const seg = safeSeg(shotId);
  if (!seg) return null;
  if (typeof file !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(file) || file.includes('..')) return null;
  const base = path.join(ASSETS_DIR, seg);
  const p = path.join(base, file);
  if (!p.startsWith(base + path.sep)) return null;
  return p;
}

module.exports = { store, resolve, ASSETS_DIR };
