'use strict';

/**
 * Permission-gated, reversible Partner action ledger.
 *
 * The model never directly mutates Raindesk. It proposes bounded actions here;
 * this module applies permission rules and only the workspace executor can
 * perform the small set of reversible spatial operations currently supported.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { HttpError } = require('./errors');
const workspace = require('./workspace');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const ACTIONS_PATH = path.join(DATA_DIR, 'partner-actions.json');
const MAX_ACTIONS = 2000;
const ACTION_TYPES = new Set([
  'focus', 'open_panel', 'close_panel', 'move_panel', 'dock_panel',
  'pin_reference', 'create_variant', 'compare_takes', 'arrange', 'link',
  'create_scene', 'create_shot', 'create_beat', 'add_annotation',
]);
const WORKSPACE_EXECUTABLE = new Set(['focus', 'open_panel', 'close_panel', 'move_panel', 'dock_panel']);
const FINAL = new Set(['accepted', 'reverted', 'failed', 'cancelled', 'advisory']);

function now() { return new Date().toISOString(); }
function emptyStore() { return { schemaVersion: 1, actions: [], createdAt: now(), updatedAt: now() }; }
function atomicWrite(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ACTIONS_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, ACTIONS_PATH);
}
function read() {
  let raw;
  try { raw = fs.readFileSync(ACTIONS_PATH, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') { const s = emptyStore(); atomicWrite(s); return s; }
    throw e;
  }
  let store;
  try { store = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'Partner action ledger is corrupt'); }
  if (!store || store.schemaVersion !== 1 || !Array.isArray(store.actions)) throw new HttpError(500, 'Partner action ledger is malformed');
  return store;
}
function write(store) {
  store.updatedAt = now();
  if (store.actions.length > MAX_ACTIONS) store.actions.splice(0, store.actions.length - MAX_ACTIONS);
  atomicWrite(store); return store;
}
function cleanAction(input = {}) {
  if (!input || typeof input !== 'object' || !ACTION_TYPES.has(input.type)) throw new HttpError(400, 'unsupported Partner action');
  let payload = {};
  if (input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)) {
    const raw = JSON.stringify(input.payload);
    if (raw.length > 16000) throw new HttpError(413, 'Partner action payload too large');
    payload = JSON.parse(raw);
  }
  return {
    type: input.type,
    targetId: input.targetId == null ? null : String(input.targetId).slice(0, 128),
    payload,
    label: input.label == null ? '' : String(input.label).slice(0, 512),
  };
}
function initialStatus(mode, type) {
  if (mode === 'watch') return 'advisory';
  if (mode === 'act' && WORKSPACE_EXECUTABLE.has(type)) return 'approved';
  return 'proposed';
}
function recordProposal(input, { permissionMode = 'suggest', turnId = null } = {}) {
  const clean = cleanAction(input);
  const store = read();
  const createdAt = now();
  const action = {
    id: `action_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`,
    ...clean,
    permissionMode: ['watch', 'suggest', 'act'].includes(permissionMode) ? permissionMode : 'suggest',
    turnId: turnId ? String(turnId).slice(0, 128) : null,
    status: initialStatus(permissionMode, clean.type),
    executable: WORKSPACE_EXECUTABLE.has(clean.type),
    receipt: null,
    inverse: null,
    error: null,
    createdAt, updatedAt: createdAt,
  };
  store.actions.push(action); write(store); return action;
}
function find(store, id) {
  const action = store.actions.find((a) => a.id === id);
  if (!action) throw new HttpError(404, 'no such Partner action');
  return action;
}
function mutate(id, fn) {
  const store = read(); const action = find(store, id); const value = fn(action, store) || action;
  action.updatedAt = now(); write(store); return value;
}
function approve(id) {
  return mutate(id, (a) => {
    if (a.status !== 'proposed') throw new HttpError(409, `action cannot be approved from ${a.status}`);
    a.status = 'approved'; return a;
  });
}
function execute(id, { workspaceImpl = workspace } = {}) {
  return mutate(id, (a) => {
    if (a.status !== 'approved') throw new HttpError(409, `action cannot execute from ${a.status}`);
    if (!a.executable) throw new HttpError(400, 'this action has no bounded executor yet');
    a.status = 'executing';
    try {
      const result = workspaceImpl.applyAction({ type: a.type, targetId: a.targetId, payload: a.payload });
      a.receipt = { kind: 'workspace', objectId: result.object && result.object.id || null, completedAt: now() };
      a.inverse = result.inverse || null;
      a.status = 'completed';
      return a;
    } catch (e) {
      a.status = 'failed'; a.error = e && e.message ? String(e.message) : String(e); return a;
    }
  });
}
function accept(id) {
  return mutate(id, (a) => {
    if (a.status !== 'completed') throw new HttpError(409, `action cannot be accepted from ${a.status}`);
    a.status = 'accepted'; return a;
  });
}
function revert(id, { workspaceImpl = workspace } = {}) {
  return mutate(id, (a) => {
    if (!['completed', 'accepted'].includes(a.status)) throw new HttpError(409, `action cannot be reverted from ${a.status}`);
    if (!a.inverse) throw new HttpError(409, 'action has no inverse receipt');
    try { workspaceImpl.applyAction(a.inverse); }
    catch (e) { throw new HttpError(409, `revert failed: ${e && e.message ? e.message : e}`); }
    a.status = 'reverted'; return a;
  });
}
function cancel(id) {
  return mutate(id, (a) => {
    if (FINAL.has(a.status) || ['executing', 'completed'].includes(a.status)) throw new HttpError(409, `action cannot be cancelled from ${a.status}`);
    a.status = 'cancelled'; return a;
  });
}
function list({ limit = 100 } = {}) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  return read().actions.slice(-n).reverse();
}

module.exports = {
  DATA_DIR, ACTIONS_PATH, ACTION_TYPES, WORKSPACE_EXECUTABLE,
  emptyStore, read, recordProposal, approve, execute, accept, revert, cancel, list,
};
