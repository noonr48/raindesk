'use strict';

/** Durable Raindesk-side lifecycle for external animatic process attempts. */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'animatic', 'execution-ledger.json');
const SCHEMA_VERSION = 1;
const STATUSES = new Set(['running', 'succeeded', 'failed', 'interrupted']);
const MAX_ATTEMPTS = 1000;

function now() { return new Date().toISOString(); }
function emptyStore() { return { schemaVersion: SCHEMA_VERSION, attempts: [], createdAt: now(), updatedAt: now() }; }

function atomicWrite(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, STORE_PATH);
}

function read() {
  let raw;
  try { raw = fs.readFileSync(STORE_PATH, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') { const store = emptyStore(); atomicWrite(store); return store; }
    throw error;
  }
  let store;
  try { store = JSON.parse(raw); } catch (_error) { throw new HttpError(500, 'animatic execution ledger is corrupt'); }
  if (!store || store.schemaVersion !== SCHEMA_VERSION || !Array.isArray(store.attempts)) throw new HttpError(500, 'animatic execution ledger is malformed');
  return store;
}

function write(store) {
  store.updatedAt = now();
  if (store.attempts.length > MAX_ATTEMPTS) store.attempts.splice(0, store.attempts.length - MAX_ATTEMPTS);
  atomicWrite(store);
  return store;
}

function newId() {
  return `exec_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
}

function begin({ invocationId, snapshotDigest } = {}) {
  if (!invocationId || !snapshotDigest) throw new HttpError(400, 'execution invocation and snapshot digest are required');
  const store = read();
  const row = {
    schemaVersion: SCHEMA_VERSION,
    executionId: newId(),
    invocationId: String(invocationId),
    snapshotDigest: String(snapshotDigest),
    status: 'running',
    startedAt: now(),
    endedAt: null,
    externalAttemptId: null,
    candidateId: null,
    errorCode: null,
    error: null,
  };
  store.attempts.push(row);
  write(store);
  return row;
}

function update(executionId, patch = {}) {
  const store = read();
  const row = store.attempts.find((item) => item && item.executionId === executionId);
  if (!row) throw new HttpError(404, 'no such animatic execution attempt');
  if (patch.status && !STATUSES.has(patch.status)) throw new HttpError(400, 'bad animatic execution status');
  if (patch.status) row.status = patch.status;
  if (patch.externalAttemptId !== undefined) row.externalAttemptId = patch.externalAttemptId || null;
  if (patch.candidateId !== undefined) row.candidateId = patch.candidateId || null;
  if (patch.errorCode !== undefined) row.errorCode = patch.errorCode || null;
  if (patch.error !== undefined) row.error = patch.error == null ? null : String(patch.error).slice(0, 4000);
  if (patch.status && patch.status !== 'running') row.endedAt = now();
  write(store);
  return row;
}

function latestForInvocation(invocationId) {
  const rows = read().attempts.filter((item) => item && item.invocationId === invocationId);
  return rows.length ? rows[rows.length - 1] : null;
}

function get(executionId) {
  return read().attempts.find((item) => item && item.executionId === executionId) || null;
}

function recoverInterrupted() {
  const store = read();
  let count = 0;
  for (const row of store.attempts) {
    if (row && row.status === 'running') {
      row.status = 'interrupted';
      row.endedAt = now();
      row.errorCode = 'server_restart';
      row.error = 'Raindesk restarted before this external process reported a terminal result.';
      count += 1;
    }
  }
  if (count) write(store);
  return count;
}

function publicRow(row) {
  if (!row) return null;
  return {
    schemaVersion: row.schemaVersion,
    executionId: row.executionId,
    invocationId: row.invocationId,
    snapshotDigest: row.snapshotDigest,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    externalAttemptId: row.externalAttemptId,
    candidateId: row.candidateId,
    errorCode: row.errorCode,
    error: row.status === 'failed' || row.status === 'interrupted'
      ? 'The animatic worker did not produce a usable candidate.' : null,
  };
}

module.exports = {
  DATA_DIR, STORE_PATH, SCHEMA_VERSION, STATUSES, MAX_ATTEMPTS,
  read, write, newId, begin, update, latestForInvocation, get, recoverInterrupted, publicRow,
};
