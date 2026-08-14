'use strict';

/**
 * Shot layer store:
 *   data/shots/{id}.json           — { id, layers: [{ file, ts }], activeLayer }
 *   data/shots/{id}/layers/{ts}.png — merged layer PNGs (client composites)
 *
 * Accepts merged layer PNG uploads (PNG magic + ≤20MB validated by caller or
 * saveLayer itself), stores them, and resolves safe paths for serving via
 * GET /api/shot/{id}/image/{file}. All writes atomic; ids strictly
 * [A-Za-z0-9_-]{1,64}; served file names must be bare basenames (no traversal).
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');
const { validatePngBuffer } = require('./validate');

// Tests may point the whole store at a scratch dir via RAINDESK_DATA_DIR.
const SHOTS_DIR = process.env.RAINDESK_DATA_DIR
  ? path.join(path.resolve(process.env.RAINDESK_DATA_DIR), 'shots')
  : path.join(__dirname, '..', 'data', 'shots');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function assertShotId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new HttpError(400, 'bad shot id (expected [A-Za-z0-9_-], 1-64 chars)');
  }
  return id;
}

function shotDir(id) {
  return path.join(SHOTS_DIR, assertShotId(id));
}

function layersDir(id) {
  return path.join(shotDir(id), 'layers');
}

// Per-task layout: meta at data/shots/{id}.json; PNGs under data/shots/{id}/layers/.
function shotMetaPath(id) {
  return path.join(SHOTS_DIR, `${assertShotId(id)}.json`);
}

/** Read { id, layers, activeLayer }; returns a fresh default when absent. */
function readShot(id) {
  assertShotId(id);
  try {
    return JSON.parse(fs.readFileSync(shotMetaPath(id), 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return { id, layers: [], activeLayer: null };
    if (e instanceof SyntaxError) throw new HttpError(500, `shot.json for ${id} is corrupt`);
    throw e;
  }
}

function writeShot(shot) {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const tmp = `${shotMetaPath(shot.id)}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(shot, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, shotMetaPath(shot.id));
}

/**
 * Store one merged layer PNG; returns { file, url, ts }.
 * File names are server-generated timestamps — never client-controlled.
 */
function saveLayer(id, buffer) {
  validatePngBuffer(buffer, `layer upload for ${id}`);
  const dir = layersDir(id);
  fs.mkdirSync(dir, { recursive: true });

  const base = Date.now();
  let file = `${base}.png`;
  for (let n = 1; fs.existsSync(path.join(dir, file)); n++) file = `${base}-${n}.png`;
  const filePath = path.join(dir, file);
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, buffer);
  fs.renameSync(tmp, filePath);

  const shot = readShot(id);
  shot.id = id;
  shot.layers = Array.isArray(shot.layers) ? shot.layers : [];
  shot.layers.push({ file, ts: new Date(base).toISOString() });
  shot.activeLayer = file;
  shot.updatedAt = new Date().toISOString();
  writeShot(shot);
  return { file, url: `/api/shot/${id}/image/${file}`, ts: new Date(base).toISOString() };
}

function listLayers(id) {
  return readShot(id).layers;
}

/**
 * Resolve a layer file for serving. Returns an absolute path ONLY when it
 * stays inside that shot's layers dir (bare basename, normalized, prefix
 * check); otherwise null -> caller answers 404.
 */
function layerPath(id, file) {
  if (typeof file !== 'string' || file === '' || file !== path.basename(file) ||
    file.includes('..') || file.includes('\0')) {
    return null;
  }
  let dir;
  try {
    dir = layersDir(id);
  } catch (_e) {
    return null;
  }
  const resolved = path.normalize(path.join(dir, file));
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) return null;
  return resolved;
}

module.exports = { readShot, writeShot, saveLayer, listLayers, layerPath, shotDir, layersDir };
