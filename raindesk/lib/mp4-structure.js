'use strict';

/**
 * Zero-dependency bounded structural MP4 validation for untrusted candidate
 * artifacts. This is NOT a codec parser: it walks top-level ISO-BMFF boxes and
 * requires the container shape a playable MP4 must have (ftyp first, moov
 * present, all box sizes bounded by the buffer). A header-only 'ftyp' blob —
 * the old fake — fails structurally here instead of at the browser.
 */

const fs = require('node:fs');
const MAX_BOXES = 1024; // bounded walk: a valid MP4 has a handful of top-level boxes

function walkBoxes(readAt, totalSize) {
  if (!(Number.isSafeInteger(totalSize) && totalSize >= 0)) return { ok: false, reason: 'invalid total size' };
  if (totalSize < 8) return { ok: false, reason: 'shorter than one box header' };
  const boxes = [];
  let offset = 0;
  let sawFtyp = false;
  let sawMoov = false;
  let first = true;
  const header = Buffer.alloc(16);
  while (offset < totalSize) {
    if (boxes.length >= MAX_BOXES) return { ok: false, reason: `more than ${MAX_BOXES} top-level boxes` };
    const got8 = readAt(header, offset, 8);
    if (got8 !== 8) return { ok: false, reason: `truncated box header at offset ${offset}` };
    let size = header.readUInt32BE(0);
    const type = header.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit largesize
      const got16 = readAt(header, offset, 16);
      if (got16 !== 16) return { ok: false, reason: `truncated largesize box at offset ${offset}` };
      const hi = header.readUInt32BE(8);
      const lo = header.readUInt32BE(12);
      if (hi !== 0) return { ok: false, reason: `unrepresentable 64-bit box size at offset ${offset}` };
      size = lo;
      headerSize = 16;
    } else if (size === 0) {
      // box extends to end of file — reject for untrusted candidates
      return { ok: false, reason: `box ${type || '?'} extends to end of file (size 0) — not accepted for candidates` };
    }
    if (size < headerSize) return { ok: false, reason: `box ${type || '?'} size ${size} below its header size` };
    if (offset + size > totalSize) return { ok: false, reason: `box ${type || '?'} size ${size} exceeds buffer at offset ${offset}` };
    if (first) {
      if (type !== 'ftyp') return { ok: false, reason: 'first box is not ftyp' };
      sawFtyp = true;
      first = false;
    }
    if (type === 'moov') sawMoov = true;
    boxes.push({ type, size, offset });
    offset += size;
  }
  if (!sawFtyp) return { ok: false, reason: 'no ftyp box' };
  if (!sawMoov) return { ok: false, reason: 'no moov box — not a playable movie container' };
  return { ok: true, boxes };
}

/**
 * @param {Buffer} bytes
 * @returns {{ok: true, boxes: Array<{type: string, size: number, offset: number}>}}
 * @returns {{ok: false, reason: string}}
 */
function validateMp4Structure(bytes) {
  if (!Buffer.isBuffer(bytes)) return { ok: false, reason: 'not a buffer' };
  return walkBoxes((dest, offset, length) => {
    if (offset + length > bytes.length) return 0;
    bytes.copy(dest, 0, offset, offset + length);
    return length;
  }, bytes.length);
}

/** Positioned-read structural validation over a file — no large allocation. */
function validateMp4StructureFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const { size } = fs.fstatSync(fd);
    return walkBoxes((dest, offset, length) => {
      if (offset + length > size) return 0;
      let done = 0;
      while (done < length) {
        const n = fs.readSync(fd, dest, done, length - done, offset + done);
        if (n <= 0) break;
        done += n;
      }
      return done;
    }, size);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { validateMp4Structure, validateMp4StructureFile, MAX_BOXES };
