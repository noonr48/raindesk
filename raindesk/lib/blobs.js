'use strict';

/**
 * Content-addressed PNG blob store used by editable shot documents.
 * Accepted raster art is immutable once written: documents reference SHA-256
 * ids, so revisions can safely share assets without copying or overwriting.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');
const { validatePngBuffer } = require('./validate');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const SHA_RE = /^[a-f0-9]{64}$/;

function assertSha(sha) {
  if (typeof sha !== 'string' || !SHA_RE.test(sha)) throw new HttpError(400, 'bad blob sha');
  return sha;
}

function blobPath(sha) {
  return path.join(BLOB_DIR, `${assertSha(sha)}.png`);
}

function putPng(buffer) {
  validatePngBuffer(buffer, 'blob upload');
  const sha = crypto.createHash('sha256').update(buffer).digest('hex');
  fs.mkdirSync(BLOB_DIR, { recursive: true });
  const target = blobPath(sha);
  if (!fs.existsSync(target)) {
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, buffer);
    try {
      fs.renameSync(tmp, target);
    } catch (e) {
      // A concurrent identical write may have won. The content hash makes that
      // outcome safe; only surface the error when the target still does not exist.
      try { fs.unlinkSync(tmp); } catch (_e) { /* already gone */ }
      if (!fs.existsSync(target)) throw e;
    }
  }
  return { sha, size: buffer.length, url: `/api/blob/${sha}` };
}

function exists(sha) {
  try { return fs.statSync(blobPath(sha)).isFile(); } catch (_e) { return false; }
}

function resolve(sha) {
  try {
    const p = blobPath(sha);
    return fs.statSync(p).isFile() ? p : null;
  } catch (_e) { return null; }
}

module.exports = { DATA_DIR, BLOB_DIR, SHA_RE, assertSha, blobPath, putPng, exists, resolve };
