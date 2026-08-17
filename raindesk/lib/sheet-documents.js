'use strict';

/**
 * Revisioned creative-sheet documents.
 *
 * Workspace objects own spatial placement. Sheet documents own creative
 * content. Every save creates an immutable revision and uses optimistic
 * concurrency so drawing never silently overwrites another edit.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SHEETS_DIR = path.join(DATA_DIR, 'sheets');
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const REV_RE = /^srev_[A-Za-z0-9_-]{8,80}$/;
const KINDS = new Set(['sketch', 'character', 'references', 'notes']);
const MAX_STROKES = 5000;
const MAX_POINTS_PER_STROKE = 20000;
const MAX_TOTAL_POINTS = 300000;
const MAX_MEDIA = 256;
const SHA_RE = /^[a-f0-9]{64}$/;

function assertId(id, what = 'sheet id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `bad ${what}`);
  return id;
}
function sheetDir(id) { return path.join(SHEETS_DIR, assertId(id)); }
function revisionsDir(id) { return path.join(sheetDir(id), 'revisions'); }
function manifestPath(id) { return path.join(sheetDir(id), 'manifest.json'); }
function revisionPath(id, revisionId) {
  assertId(id);
  if (typeof revisionId !== 'string' || !REV_RE.test(revisionId)) throw new HttpError(400, 'bad sheet revision id');
  return path.join(revisionsDir(id), `${revisionId}.json`);
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function makeSheetId() {
  return `sheet_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}
function makeRevisionId() {
  return `srev_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}
function readManifest(id) {
  assertId(id);
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'));
    if (!m || m.schemaVersion !== 1 || m.sheetId !== id || !Array.isArray(m.revisions)) {
      throw new HttpError(500, `sheet manifest for ${id} is malformed`);
    }
    return m;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) throw new HttpError(500, `sheet manifest for ${id} is corrupt`);
    throw e;
  }
}
function cleanStroke(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points) || !raw.points.length) {
    throw new HttpError(400, 'sheet stroke is malformed');
  }
  if (raw.points.length > MAX_POINTS_PER_STROKE) throw new HttpError(413, 'sheet stroke is too large');
  const id = String(raw.id || `stroke_${index}`).slice(0, 128);
  const points = raw.points.map((p) => {
    const x = Number(p && p.x); const y = Number(p && p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, 'sheet stroke has bad point');
    return { x, y };
  });
  return {
    id,
    points,
    color: String(raw.color || '#2d3233').slice(0, 64),
    width: Math.max(0.1, Math.min(256, Number(raw.width) || 2.2)),
  };
}
function cleanMedia(raw, index = 0) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'sheet media is malformed');
  const kind = String(raw.kind || 'image');
  if (kind !== 'image') throw new HttpError(400, `unsupported sheet media kind "${kind}"`);
  const sha = String(raw.sha || raw.referenceId || '');
  if (!SHA_RE.test(sha)) throw new HttpError(400, 'sheet media has bad blob sha');
  const number = (value, fallback = 0) => { const n = Number(value); return Number.isFinite(n) ? n : fallback; };
  const width = Math.max(8, Math.min(4096, number(raw.width, 320)));
  const height = Math.max(8, Math.min(4096, number(raw.height, 240)));
  return {
    id: String(raw.id || `media_${index}`).slice(0, 128),
    kind: 'image', sha,
    x: number(raw.x), y: number(raw.y), width, height,
    rotation: Math.max(-3600, Math.min(3600, number(raw.rotation))),
    opacity: Math.max(0.05, Math.min(1, number(raw.opacity, 1))),
    zIndex: Math.max(-10000, Math.min(10000, Math.round(number(raw.zIndex, index)))),
    caption: String(raw.caption || '').slice(0, 500),
  };
}

function validateDocument(sheetId, input) {
  assertId(sheetId);
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) {
    throw new HttpError(400, 'sheet document schemaVersion must be 1');
  }
  if (input.sheetId && input.sheetId !== sheetId) throw new HttpError(400, 'sheet document id mismatch');
  const title = String(input.title || 'Untitled sheet').trim().slice(0, 200) || 'Untitled sheet';
  const kind = String(input.kind || 'sketch');
  if (!KINDS.has(kind)) throw new HttpError(400, `unsupported sheet kind "${kind}"`);
  const canvas = input.canvas || {};
  const width = Number(canvas.width); const height = Number(canvas.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width > 4096 || height > 4096) {
    throw new HttpError(400, 'sheet document has invalid canvas dimensions');
  }
  if (!Array.isArray(input.strokes) || input.strokes.length > MAX_STROKES) {
    throw new HttpError(400, `sheet strokes must be an array <=${MAX_STROKES}`);
  }
  let total = 0;
  const strokes = input.strokes.map((st, index) => {
    const clean = cleanStroke(st, index); total += clean.points.length; return clean;
  });
  if (total > MAX_TOTAL_POINTS) throw new HttpError(413, 'sheet contains too many vector points');
  if (input.media !== undefined && !Array.isArray(input.media)) throw new HttpError(400, 'sheet media must be an array');
  const mediaInput = Array.isArray(input.media) ? input.media : [];
  if (mediaInput.length > MAX_MEDIA) throw new HttpError(413, `sheet media must be <=${MAX_MEDIA}`);
  const media = mediaInput.map((item, index) => cleanMedia(item, index));
  const mediaIds = new Set();
  for (const item of media) {
    if (!item.id || mediaIds.has(item.id)) throw new HttpError(400, 'sheet media ids must be unique');
    mediaIds.add(item.id);
  }
  return {
    schemaVersion: 1,
    sheetId,
    title,
    kind,
    canvas: { width, height },
    media,
    strokes,
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
}
function readRevision(id, revisionId) {
  let value;
  try { value = JSON.parse(fs.readFileSync(revisionPath(id, revisionId), 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new HttpError(404, 'no such sheet revision');
    if (e instanceof SyntaxError) throw new HttpError(500, `sheet revision ${revisionId} is corrupt`);
    throw e;
  }
  return value;
}
function readCurrent(id) {
  const manifest = readManifest(id);
  if (!manifest || !manifest.currentRevisionId) return null;
  return readRevision(id, manifest.currentRevisionId);
}
function save(id, document, { baseRevisionId = null, reason = 'edit', restoredFromRevisionId = null } = {}) {
  assertId(id);
  const clean = validateDocument(id, document);
  const manifest = readManifest(id) || {
    schemaVersion: 1, sheetId: id, currentRevisionId: null, revisions: [],
    createdAt: new Date().toISOString(), updatedAt: null,
  };
  const current = manifest.currentRevisionId || null;
  if (current && baseRevisionId !== current) {
    throw new HttpError(409, `sheet changed since this edit (current revision ${current})`);
  }
  if (!current && baseRevisionId) throw new HttpError(409, 'sheet has no base revision yet');
  const revisionId = makeRevisionId();
  const createdAt = new Date().toISOString();
  const revision = {
    schemaVersion: 1,
    sheetId: id,
    revisionId,
    parentRevisionId: current,
    reason: String(reason || 'edit').slice(0, 256),
    restoredFromRevisionId: restoredFromRevisionId ? String(restoredFromRevisionId).slice(0, 160) : null,
    createdAt,
    document: clean,
  };
  atomicJson(revisionPath(id, revisionId), revision);
  manifest.currentRevisionId = revisionId;
  manifest.updatedAt = createdAt;
  manifest.revisions.push({
    revisionId, parentRevisionId: current, reason: revision.reason,
    restoredFromRevisionId: revision.restoredFromRevisionId, createdAt,
  });
  atomicJson(manifestPath(id), manifest);
  return revision;
}
function create({ sheetId = null, title = 'Loose sketch', kind = 'sketch', canvas = null, meta = {} } = {}) {
  const id = assertId(sheetId || makeSheetId());
  if (readManifest(id)) throw new HttpError(409, 'sheet already exists');
  const defaultCanvas = kind === 'references' ? { width: 900, height: 700 } : { width: 700, height: 900 };
  return save(id, {
    schemaVersion: 1,
    sheetId: id,
    title,
    kind,
    canvas: canvas || defaultCanvas,
    media: [],
    strokes: [],
    meta,
  }, { reason: 'create sheet' });
}
function restore(id, revisionId, { baseRevisionId = null, reason = 'restore sheet revision' } = {}) {
  const source = readRevision(id, revisionId);
  return save(id, source.document, { baseRevisionId, reason, restoredFromRevisionId: revisionId });
}
function history(id) {
  const manifest = readManifest(id);
  return manifest ? { ...manifest, revisions: manifest.revisions.slice().reverse() } : {
    schemaVersion: 1, sheetId: assertId(id), currentRevisionId: null, revisions: [], createdAt: null, updatedAt: null,
  };
}
function list() {
  try {
    return fs.readdirSync(SHEETS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && ID_RE.test(entry.name))
      .map((entry) => {
        try {
          const current = readCurrent(entry.name);
          if (!current) return null;
          return {
            sheetId: entry.name,
            revisionId: current.revisionId,
            title: current.document.title,
            kind: current.document.kind,
            canvas: current.document.canvas,
            strokeCount: current.document.strokes.length,
            mediaCount: Array.isArray(current.document.media) ? current.document.media.length : 0,
            updatedAt: current.createdAt,
          };
        } catch (_e) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

module.exports = {
  DATA_DIR, SHEETS_DIR, ID_RE, KINDS, MAX_STROKES, MAX_POINTS_PER_STROKE, MAX_TOTAL_POINTS, MAX_MEDIA, SHA_RE,
  assertId, cleanMedia, validateDocument, readManifest, readRevision, readCurrent, save, create, restore, history, list,
};
