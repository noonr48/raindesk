'use strict';

/**
 * Durable Invocation Ledger — Surface Hand-off v1 hardening.
 *
 * Invocation requests are ephemeral by birth (a Partner turn); this ledger
 * gives the APPROVAL side a durable, bounded lifecycle so a page reload can
 * restore pending approvals and a newer same-scope request marks the prior
 * one stale. It never executes anything and never stores artwork — only the
 * bounded request record and its lifecycle stamps.
 *
 * Pattern-cloned from partner-actions.js (atomic write, cap, strict shapes).
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'invocation-ledger.json');
const MAX_ENTRIES = 500;
const STATUSES = new Set(['proposed', 'approved', 'stale', 'handed_off', 'cancelled']);

function now() { return new Date().toISOString(); }
function emptyStore() { return { schemaVersion: 1, invocations: [], createdAt: now(), updatedAt: now() }; }

function atomicWrite(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${LEDGER_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, LEDGER_PATH);
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
  if (!store || store.schemaVersion !== 1 || !Array.isArray(store.invocations)) {
    throw new HttpError(500, 'Invocation ledger is malformed');
  }
  return store;
}

function write(store) {
  store.updatedAt = now();
  if (store.invocations.length > MAX_ENTRIES) store.invocations.splice(0, store.invocations.length - MAX_ENTRIES);
  atomicWrite(store);
  return store;
}

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function cleanInvocation(input = {}) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'invocation record is required');
  const id = text(input.id, 96);
  if (!id) throw new HttpError(400, 'invocation id is required');
  const entry = {
    id,
    requestId: text(input.requestId, 96) || id,
    turnId: text(input.turnId, 128) || null,
    shotId: text(input.shotId, 96) || null,
    adapterId: text(input.adapterId, 96) || null,
    capabilityId: text(input.capabilityId, 96) || null,
    status: STATUSES.has(input.status) ? input.status : 'proposed',
    approvedAt: text(input.approvedAt, 64) || null,
    staleAt: text(input.staleAt, 64) || null,
    handedOffAt: text(input.handedOffAt, 64) || null,
    recordedAt: input.recordedAt || now(),
  };
  const raw = JSON.stringify(entry);
  if (raw.length > 8000) throw new HttpError(413, 'invocation record too large');
  return entry;
}

function find(store, id) {
  return store.invocations.find((item) => item && item.id === id) || null;
}

function record(input) {
  const store = read();
  const entry = cleanInvocation(input);
  const existing = find(store, entry.id);
  if (existing) return { entry: existing, created: false };
  store.invocations.push(entry);
  write(store);
  return { entry, created: true };
}

function setStatus(id, status, stamp = status === 'approved' ? 'approvedAt' : status === 'stale' ? 'staleAt' : status === 'handed_off' ? 'handedOffAt' : null) {
  const store = read();
  const entry = find(store, text(id, 96));
  if (!entry) return null;
  if (!STATUSES.has(status)) throw new HttpError(400, 'unknown invocation status');
  entry.status = status;
  if (stamp) entry[stamp] = now();
  write(store);
  return entry;
}

function pendingForShot(shotId) {
  const store = read();
  const key = text(shotId, 96);
  return store.invocations.filter((item) => item && item.shotId === key &&
    (item.status === 'proposed' || item.status === 'approved'));
}

/** A newer approved/proposed request for the same shot + adapter marks prior ones stale. */
function markStaleSuperseded({ shotId, requestId }) {
  const store = read();
  const key = text(shotId, 96);
  const rid = text(requestId, 96);
  let marked = 0;
  for (const item of store.invocations) {
    if (item && item.shotId === key && item.requestId !== rid &&
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
  STATUSES, MAX_ENTRIES,
  read, write, record, find, setStatus, pendingForShot, markStaleSuperseded, list,
};
