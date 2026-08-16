'use strict';

/**
 * Immutable, optimistic-concurrency shot document revisions.
 *
 * A revision stores editable layer metadata while raster bytes live in the
 * content-addressed blob store. Saving never overwrites an earlier revision.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');
const blobs = require('./blobs');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DOCS_DIR = path.join(DATA_DIR, 'documents');
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const LAYER_KINDS = new Set(['base', 'pen', 'vector', 'raster', 'temp', 'gen']);
const VECTOR_KINDS = new Set(['pen', 'vector']);
const RASTER_KINDS = new Set(['base', 'raster', 'temp', 'gen']);

function assertId(id, what = 'shot id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `bad ${what}`);
  return id;
}
function shotDir(id) { return path.join(DOCS_DIR, assertId(id)); }
function revisionsDir(id) { return path.join(shotDir(id), 'revisions'); }
function manifestPath(id) { return path.join(shotDir(id), 'manifest.json'); }
function revisionPath(id, revisionId) {
  if (typeof revisionId !== 'string' || !/^rev_[A-Za-z0-9_-]{8,80}$/.test(revisionId)) {
    throw new HttpError(400, 'bad revision id');
  }
  return path.join(revisionsDir(id), `${revisionId}.json`);
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function readManifest(id) {
  assertId(id);
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'));
    if (!m || m.schemaVersion !== 1 || m.shotId !== id || !Array.isArray(m.revisions)) {
      throw new HttpError(500, `document manifest for ${id} is malformed`);
    }
    return m;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    if (e instanceof SyntaxError) throw new HttpError(500, `document manifest for ${id} is corrupt`);
    throw e;
  }
}

function cleanStroke(stroke, layerId) {
  if (!stroke || typeof stroke !== 'object' || !Array.isArray(stroke.points) || !stroke.points.length) {
    throw new HttpError(400, `vector layer ${layerId} has malformed stroke`);
  }
  if (stroke.points.length > 20000) throw new HttpError(413, `stroke in ${layerId} is too large`);
  return {
    id: String(stroke.id || '').slice(0, 128),
    points: stroke.points.map((p) => {
      const x = Number(p && p.x); const y = Number(p && p.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new HttpError(400, `stroke in ${layerId} has bad point`);
      return { x, y };
    }),
    color: String(stroke.color || '#000000').slice(0, 64),
    width: Math.max(0.1, Math.min(512, Number(stroke.width) || 1)),
  };
}

function validateDocument(shotId, input) {
  assertId(shotId);
  if (!input || typeof input !== 'object' || input.schemaVersion !== 1) {
    throw new HttpError(400, 'shot document schemaVersion must be 1');
  }
  if (input.shotId && input.shotId !== shotId) throw new HttpError(400, 'shot document id mismatch');
  const canvas = input.canvas || {};
  const width = Number(canvas.width); const height = Number(canvas.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) {
    throw new HttpError(400, 'shot document has invalid canvas dimensions');
  }
  if (!Array.isArray(input.layers) || input.layers.length > 256) throw new HttpError(400, 'shot document layers must be an array <=256');

  const ids = new Set();
  const layers = input.layers.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !ID_RE.test(raw.id) || ids.has(raw.id)) {
      throw new HttpError(400, 'shot document has invalid or duplicate layer id');
    }
    ids.add(raw.id);
    if (!LAYER_KINDS.has(raw.kind)) throw new HttpError(400, `unsupported layer kind "${raw.kind}"`);
    const vector = VECTOR_KINDS.has(raw.kind);
    const raster = RASTER_KINDS.has(raw.kind);
    const assetSha = raw.assetSha == null || raw.assetSha === '' ? null : String(raw.assetSha);
    if (vector && assetSha) throw new HttpError(400, `vector layer ${raw.id} must not reference raster bytes`);
    if (raster && !assetSha) throw new HttpError(400, `raster layer ${raw.id} requires immutable pixel bytes`);
    if (raster && !blobs.exists(assetSha)) throw new HttpError(400, `missing raster blob for layer ${raw.id}`);
    const strokes = vector
      ? (Array.isArray(raw.strokes) ? raw.strokes.map((st) => cleanStroke(st, raw.id)) : [])
      : [];
    return {
      id: raw.id,
      name: String(raw.name || raw.kind).slice(0, 512),
      kind: raw.kind,
      visible: raw.visible !== false,
      order: Number.isFinite(raw.order) ? Number(raw.order) : index,
      strokes,
      assetSha: raster ? assetSha : null,
      sourceTakeId: raw.kind === 'gen' && raw.sourceTakeId
        ? String(raw.sourceTakeId).slice(0, 160)
        : null,
    };
  });
  if (input.activeLayerId != null && !ids.has(input.activeLayerId)) {
    throw new HttpError(400, 'activeLayerId does not exist in shot document');
  }
  return {
    schemaVersion: 1,
    shotId,
    canvas: { width, height },
    activeLayerId: input.activeLayerId || null,
    layers,
    meta: input.meta && typeof input.meta === 'object' ? input.meta : {},
  };
}

function makeRevisionId() {
  return `rev_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

function readRevision(id, revisionId) {
  assertId(id);
  let value;
  try { value = JSON.parse(fs.readFileSync(revisionPath(id, revisionId), 'utf8')); }
  catch (e) {
    if (e && e.code === 'ENOENT') throw new HttpError(404, 'no such shot revision');
    if (e instanceof SyntaxError) throw new HttpError(500, `shot revision ${revisionId} is corrupt`);
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
    schemaVersion: 1, shotId: id, currentRevisionId: null, revisions: [], createdAt: new Date().toISOString(), updatedAt: null,
  };
  const current = manifest.currentRevisionId || null;
  if (current && baseRevisionId !== current) {
    throw new HttpError(409, `shot changed since this edit (current revision ${current})`);
  }
  if (!current && baseRevisionId) throw new HttpError(409, 'shot has no base revision yet');

  const revisionId = makeRevisionId();
  const createdAt = new Date().toISOString();
  const revision = {
    schemaVersion: 1,
    shotId: id,
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
  manifest.revisions.push({ revisionId, parentRevisionId: current, reason: revision.reason, restoredFromRevisionId: revision.restoredFromRevisionId, createdAt });
  atomicJson(manifestPath(id), manifest);
  return revision;
}

function restore(id, revisionId, { baseRevisionId = null, reason = 'restore revision' } = {}) {
  const source = readRevision(id, revisionId);
  return save(id, source.document, {
    baseRevisionId,
    reason,
    restoredFromRevisionId: revisionId,
  });
}

function list(id) {
  const manifest = readManifest(id);
  return manifest ? { ...manifest, revisions: manifest.revisions.slice().reverse() } : {
    schemaVersion: 1, shotId: assertId(id), currentRevisionId: null, revisions: [], createdAt: null, updatedAt: null,
  };
}

module.exports = {
  DATA_DIR, DOCS_DIR, ID_RE, LAYER_KINDS, VECTOR_KINDS, RASTER_KINDS,
  assertId, validateDocument, readManifest, readRevision, readCurrent, save, restore, list,
};
