'use strict';

/**
 * Durable generated-take metadata.
 *
 * Takes are immutable candidates until their status is explicitly changed.
 * Raster bytes live in the content-addressed blob store; this file only keeps
 * provenance and creative lifecycle metadata.  A take never overwrites the
 * editable ShotDocument by itself.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const TAKES_PATH = path.join(DATA_DIR, 'takes.json');
const MAX_TAKES = 4000;
const STATUS = ['candidate', 'accepted', 'rejected', 'superseded'];
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

function emptyStore() { return { schemaVersion: 1, takes: [], updatedAt: null }; }

function readStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TAKES_PATH, 'utf8'));
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.takes)) throw new Error('bad schema');
    return parsed;
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyStore();
    if (e instanceof SyntaxError || (e && e.message === 'bad schema')) {
      throw new HttpError(500, 'takes store is corrupt');
    }
    throw e;
  }
}

function writeStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  store.updatedAt = new Date().toISOString();
  if (store.takes.length > MAX_TAKES) {
    // Never prune live candidates or accepted takes. Prefer old rejected /
    // superseded metadata first; raster blobs are content-addressed separately.
    const removable = store.takes
      .filter((t) => t.status === 'rejected' || t.status === 'superseded')
      .sort((a, b) => String(a.updatedAt || a.createdAt).localeCompare(String(b.updatedAt || b.createdAt)));
    const removeIds = new Set(removable.slice(0, Math.max(0, store.takes.length - MAX_TAKES)).map((t) => t.id));
    store.takes = store.takes.filter((t) => !removeIds.has(t.id));
  }
  const tmp = `${TAKES_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, TAKES_PATH);
}

function safeText(v, max = 16000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function safeRegion(v) {
  if (!v || typeof v !== 'object') return null;
  const nums = ['x', 'y', 'w', 'h'].map((k) => Number(v[k]));
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = nums;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function safePoints(v, max = 4096) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, max).map((p) => ({ x: Number(p && p.x), y: Number(p && p.y) }))
    .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function makeId(store, shotId, jobId) {
  const base = `take_${String(shotId).replace(/[^A-Za-z0-9_-]/g, '_')}_${String(jobId).replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 145);
  let id = base;
  for (let n = 2; store.takes.some((t) => t.id === id); n++) id = `${base}_${n}`.slice(0, 160);
  return id;
}

function createCandidate(input) {
  const shotId = safeText(input && input.shotId, 64);
  const jobId = safeText(input && input.jobId, 64);
  const resultAssetSha = safeText(input && input.resultAssetSha, 64);
  if (!shotId || !jobId || !resultAssetSha) throw new HttpError(400, 'shotId, jobId and durable resultAssetSha are required');
  const store = readStore();
  const id = makeId(store, shotId, jobId);
  const now = new Date().toISOString();
  const take = {
    id,
    shotId,
    jobId,
    status: 'candidate',
    prompt: safeText(input.prompt),
    negative: safeText(input.negative),
    seed: input.seed == null ? null : Number(input.seed),
    baseRevisionId: safeText(input.baseRevisionId, 160) || null,
    sourceRegionAssetSha: safeText(input.sourceRegionAssetSha, 64) || null,
    maskAssetSha: safeText(input.maskAssetSha, 64) || null,
    resultAssetSha,
    region: safeRegion(input.region),
    lasso: safePoints(input.lasso),
    acceptedRevisionId: null,
    createdAt: now,
    updatedAt: now,
  };
  store.takes.push(take);
  writeStore(store);
  return take;
}

function get(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return readStore().takes.find((t) => t.id === id) || null;
}

function list({ shotId = null, status = null, limit = 200 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
  let out = readStore().takes;
  if (shotId) out = out.filter((t) => t.shotId === shotId);
  if (status) out = out.filter((t) => t.status === status);
  return out.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, n);
}

function setStatus(id, status, { revisionId = null } = {}) {
  if (!STATUS.includes(status)) throw new HttpError(400, `bad take status: ${status}`);
  const store = readStore();
  const take = store.takes.find((t) => t.id === id);
  if (!take) throw new HttpError(404, 'no such take');
  take.status = status;
  if (status === 'accepted') take.acceptedRevisionId = safeText(revisionId, 160) || take.acceptedRevisionId || null;
  if (status === 'candidate') take.acceptedRevisionId = null;
  take.updatedAt = new Date().toISOString();
  writeStore(store);
  return take;
}

module.exports = {
  TAKES_PATH, STATUS, readStore, createCandidate, get, list, setStatus,
};
