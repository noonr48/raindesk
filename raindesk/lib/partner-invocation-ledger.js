'use strict';

/**
 * Durable Invocation Ledger v2.
 *
 * Approval is authority, not merely UI state. The ledger therefore preserves
 * the bounded immutable request facts that were approved so reload/retry or a
 * later external process cannot silently broaden the request. It still never
 * executes anything and never stores artwork bytes.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'invocation-ledger.json');
const STORE_SCHEMA_VERSION = 2;
const MAX_ENTRIES = 500;
const MAX_RECORD_BYTES = 64 * 1024;
const STATUSES = new Set(['proposed', 'approved', 'stale', 'handed_off', 'cancelled']);

function now() { return new Date().toISOString(); }
function emptyStore() { return { schemaVersion: STORE_SCHEMA_VERSION, invocations: [], createdAt: now(), updatedAt: now() }; }

function atomicWrite(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LEDGER_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, LEDGER_PATH);
}

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function textList(value, maxItems = 64, maxLen = 240) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const clean = text(item, maxLen);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }

function boundedObject(value, what, maxBytes = 32 * 1024) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${what} must be an object`);
  let raw;
  try { raw = JSON.stringify(value); } catch (_e) { throw new HttpError(400, `${what} is not serializable`); }
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) throw new HttpError(413, `${what} is too large`);
  try { return JSON.parse(raw); } catch (_e) { throw new HttpError(400, `${what} is malformed`); }
}

function cleanScope(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invocation scope must be an object');
  const scope = {
    shotId: text(value.shotId, 96) || null,
    artRevisionId: text(value.artRevisionId, 160) || null,
    selectionFingerprint: text(value.selectionFingerprint, 96) || null,
    selectionStable: boundedObject(value.selectionStable, 'frozen selection'),
  };
  if (Buffer.byteLength(JSON.stringify(scope), 'utf8') > 40 * 1024) throw new HttpError(413, 'invocation scope is too large');
  return scope;
}

function cleanInvocation(input = {}, { preserveTimestamps = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'invocation record is required');
  const id = text(input.id, 96);
  if (!id) throw new HttpError(400, 'invocation id is required');
  const scope = cleanScope(input.scope);
  const shotId = text(input.shotId, 96) || (scope && scope.shotId) || null;
  if (scope && scope.shotId && shotId && scope.shotId !== shotId) throw new HttpError(400, 'invocation shotId conflicts with frozen scope');
  const entry = {
    schemaVersion: STORE_SCHEMA_VERSION,
    id,
    requestId: text(input.requestId, 96) || id,
    turnId: text(input.turnId, 128) || null,
    shotId,
    adapterId: text(input.adapterId, 96) || null,
    capabilityId: text(input.capabilityId, 96) || null,
    stageId: text(input.stageId, 256) || null,
    recipeId: text(input.recipeId, 96) || null,
    invocationBoundary: text(input.invocationBoundary, 32) || null,
    disposition: text(input.disposition, 32) || null,
    reviewRequired: typeof input.reviewRequired === 'boolean' ? input.reviewRequired : null,
    creativeMutation: typeof input.creativeMutation === 'boolean' ? input.creativeMutation : null,
    scope,
    requiredEvidence: textList(input.requiredEvidence, 64, 160),
    requiredInputs: textList(input.requiredInputs, 64, 200),
    expectedOutputs: textList(input.expectedOutputs, 64, 200),
    preserves: textList(input.preserves, 64, 240),
    sideEffects: textList(input.sideEffects, 32, 240),
    status: STATUSES.has(input.status) ? input.status : 'proposed',
    approvedAt: preserveTimestamps ? (text(input.approvedAt, 64) || null) : null,
    staleAt: preserveTimestamps ? (text(input.staleAt, 64) || null) : null,
    handedOffAt: preserveTimestamps ? (text(input.handedOffAt, 64) || null) : null,
    cancelledAt: preserveTimestamps ? (text(input.cancelledAt, 64) || null) : null,
    recordedAt: preserveTimestamps ? (text(input.recordedAt, 64) || null) : now(),
  };
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_RECORD_BYTES) throw new HttpError(413, 'invocation record too large');
  return entry;
}

function immutableShape(entry) {
  return {
    requestId: entry.requestId,
    turnId: entry.turnId,
    shotId: entry.shotId,
    adapterId: entry.adapterId,
    capabilityId: entry.capabilityId,
    stageId: entry.stageId,
    recipeId: entry.recipeId,
    invocationBoundary: entry.invocationBoundary,
    disposition: entry.disposition,
    reviewRequired: entry.reviewRequired,
    creativeMutation: entry.creativeMutation,
    scope: entry.scope,
    requiredEvidence: entry.requiredEvidence,
    requiredInputs: entry.requiredInputs,
    expectedOutputs: entry.expectedOutputs,
    preserves: entry.preserves,
    sideEffects: entry.sideEffects,
  };
}

function migrateV1(store) {
  if (!store || store.schemaVersion !== 1 || !Array.isArray(store.invocations)) {
    throw new HttpError(500, 'Invocation ledger is malformed');
  }
  let invocations;
  try { invocations = store.invocations.map((item) => cleanInvocation(item, { preserveTimestamps: true })); }
  catch (_error) { throw new HttpError(500, 'Invocation ledger v1 contains a malformed record'); }
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    invocations,
    createdAt: text(store.createdAt, 64) || now(),
    updatedAt: now(),
  };
}

function read() {
  let raw;
  try { raw = fs.readFileSync(LEDGER_PATH, 'utf-8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') { const s = emptyStore(); atomicWrite(s); return s; }
    throw e;
  }
  let store;
  try { store = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'Invocation ledger is corrupt'); }
  if (store && store.schemaVersion === 1) {
    const migrated = migrateV1(store);
    atomicWrite(migrated);
    return migrated;
  }
  if (!store || store.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(store.invocations)) {
    throw new HttpError(500, 'Invocation ledger is malformed');
  }
  return store;
}

function write(store) {
  if (!store || store.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(store.invocations)) {
    throw new HttpError(500, 'Invocation ledger write shape is invalid');
  }
  store.updatedAt = now();
  if (store.invocations.length > MAX_ENTRIES) store.invocations.splice(0, store.invocations.length - MAX_ENTRIES);
  atomicWrite(store);
  return store;
}

function find(store, id) {
  return store.invocations.find((item) => item && item.id === id) || null;
}

function record(input) {
  const store = read();
  const id = text(input && input.id, 96);
  if (!id) throw new HttpError(400, 'invocation id is required');
  const existing = find(store, id);
  if (existing) {
    const candidate = cleanInvocation({ ...existing, ...input }, { preserveTimestamps: true });
    if (canonicalJson(immutableShape(candidate)) !== canonicalJson(immutableShape(existing))) {
      throw new HttpError(409, `invocation ${id} already exists with different immutable request authority`);
    }
    return { entry: existing, created: false };
  }
  const entry = cleanInvocation(input);
  const stamp = now();
  if (entry.status === 'approved') entry.approvedAt = stamp;
  if (entry.status === 'stale') entry.staleAt = stamp;
  if (entry.status === 'handed_off') entry.handedOffAt = stamp;
  if (entry.status === 'cancelled') entry.cancelledAt = stamp;
  store.invocations.push(entry);
  write(store);
  return { entry, created: true };
}

function setStatus(id, status) {
  const store = read();
  const entry = find(store, text(id, 96));
  if (!entry) return null;
  if (!STATUSES.has(status)) throw new HttpError(400, 'unknown invocation status');
  entry.status = status;
  const stamp = now();
  if (status === 'approved') entry.approvedAt = stamp;
  if (status === 'stale') entry.staleAt = stamp;
  if (status === 'handed_off') entry.handedOffAt = stamp;
  if (status === 'cancelled') entry.cancelledAt = stamp;
  write(store);
  return entry;
}

function pendingForShot(shotId) {
  const store = read();
  const key = text(shotId, 96);
  return store.invocations.filter((item) => item && item.shotId === key &&
    (item.status === 'proposed' || item.status === 'approved'));
}

/**
 * A newer request supersedes only pending requests for the same shot+adapter.
 * The adapter-less fallback exists solely for schema-v1/legacy callers that
 * predate v2 authority records; all v2 Raindesk requests carry adapterId.
 */
function markStaleSuperseded({ shotId, requestId, adapterId = null }) {
  const store = read();
  const key = text(shotId, 96);
  const rid = text(requestId, 96);
  const adapterKey = text(adapterId, 96) || null;
  let marked = 0;
  for (const item of store.invocations) {
    const sameAdapter = adapterKey ? item.adapterId === adapterKey : true;
    if (item && item.shotId === key && sameAdapter && item.requestId !== rid &&
      (item.status === 'proposed' || item.status === 'approved')) {
      item.status = 'stale';
      item.staleAt = now();
      marked += 1;
    }
  }
  if (marked) write(store);
  return marked;
}

function list({ shotId = null, status = null, limit = 100 } = {}) {
  const store = read();
  let rows = store.invocations.slice();
  if (shotId) rows = rows.filter((item) => item.shotId === text(shotId, 96));
  if (status) rows = rows.filter((item) => item.status === text(status, 32));
  return rows.slice(-Math.max(1, Math.min(500, limit)));
}

module.exports = {
  DATA_DIR, LEDGER_PATH, STORE_SCHEMA_VERSION, STATUSES, MAX_ENTRIES, MAX_RECORD_BYTES,
  canonicalValue, canonicalJson, cleanScope, cleanInvocation, immutableShape, migrateV1,
  read, write, record, find, setStatus, pendingForShot, markStaleSuperseded, list,
};
