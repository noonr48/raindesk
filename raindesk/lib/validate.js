'use strict';

const { HttpError } = require('./errors');

const MAX_PNG_BYTES = 20 * 1024 * 1024; // 20 MB

/** True when buffer starts with the 8-byte PNG signature. */
function isPng(buf) {
  return Buffer.isBuffer(buf) && buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
}

/** Throws HttpError for non-PNG (400) or oversize (413); returns the buffer. */
function validatePngBuffer(buf, what = 'upload', maxBytes = MAX_PNG_BYTES) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    throw new HttpError(400, `${what}: empty body`);
  }
  if (!isPng(buf)) {
    throw new HttpError(400, `${what}: not a PNG (bad magic bytes)`);
  }
  if (buf.length > maxBytes) {
    throw new HttpError(413, `${what}: PNG larger than ${maxBytes} bytes`);
  }
  return buf;
}

module.exports = { isPng, validatePngBuffer, MAX_PNG_BYTES };
