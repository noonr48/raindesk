'use strict';

/**
 * Persistent spatial workspace model for the future endless Raindesk desk.
 *
 * This is intentionally visual-style agnostic. It stores stable object IDs,
 * world transforms and floating/docked/minimised state so the UI and Partner
 * can refer to the same things without pixel-coordinate guessing.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const WORKSPACE_PATH = path.join(DATA_DIR, 'workspace.json');
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const OBJECT_TYPES = new Set([
  'sheet', 'shot', 'comic_page', 'reference_board', 'character_canvas', 'note',
  'sequence_strip', 'layers_panel', 'beat_trail', 'partner_panel', 'generic_panel',
]);
const DOCKS = new Set(['top', 'right', 'bottom', 'left']);

function now() { return new Date().toISOString(); }
function emptyWorkspace() {
  return {
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    activeObjectId: null,
    objects: [],
    createdAt: now(), updatedAt: now(),
  };
}
function atomicWrite(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${WORKSPACE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, WORKSPACE_PATH);
}
function read() {
  let raw;
  try { raw = fs.readFileSync(WORKSPACE_PATH, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') { const ws = emptyWorkspace(); atomicWrite(ws); return ws; }
    throw e;
  }
  let ws;
  try { ws = JSON.parse(raw); } catch (_e) { throw new HttpError(500, 'workspace state is corrupt'); }
  if (!ws || ws.schemaVersion !== 1 || !Array.isArray(ws.objects) || !ws.viewport) {
    throw new HttpError(500, 'workspace state is malformed');
  }
  return ws;
}
function write(ws) { ws.updatedAt = now(); atomicWrite(ws); return ws; }
function assertId(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, 'bad workspace object id');
  return id;
}
function finite(value, fallback, min = -10000000, max = 10000000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
function sanitizeObject(input = {}, existing = null) {
  const id = assertId(input.id || (existing && existing.id));
  const type = OBJECT_TYPES.has(input.type) ? input.type : (existing && existing.type) || 'generic_panel';
  return {
    id,
    type,
    entityRef: input.entityRef !== undefined ? (input.entityRef == null ? null : String(input.entityRef).slice(0, 256)) : (existing && existing.entityRef) || null,
    x: finite(input.x, existing ? existing.x : 0),
    y: finite(input.y, existing ? existing.y : 0),
    width: finite(input.width, existing ? existing.width : 360, 40, 20000),
    height: finite(input.height, existing ? existing.height : 260, 40, 20000),
    rotation: finite(input.rotation, existing ? existing.rotation : 0, -360000, 360000),
    scale: finite(input.scale, existing ? existing.scale : 1, 0.05, 64),
    zIndex: finite(input.zIndex, existing ? existing.zIndex : 0, -100000, 100000),
    collapsed: input.collapsed !== undefined ? Boolean(input.collapsed) : Boolean(existing && existing.collapsed),
    visible: input.visible !== undefined ? Boolean(input.visible) : (existing ? existing.visible !== false : true),
    locked: input.locked !== undefined ? Boolean(input.locked) : Boolean(existing && existing.locked),
    dock: input.dock === null ? null : (DOCKS.has(input.dock) ? input.dock : (existing && existing.dock) || null),
    groupId: input.groupId !== undefined ? (input.groupId == null ? null : String(input.groupId).slice(0, 96)) : (existing && existing.groupId) || null,
    updatedAt: now(),
  };
}
function getObject(ws, id) { return ws.objects.find((o) => o.id === id) || null; }
function upsertObject(input) {
  const ws = read();
  const id = assertId(input && input.id);
  const existing = getObject(ws, id);
  const next = sanitizeObject(input, existing);
  if (existing) Object.assign(existing, next); else ws.objects.push(next);
  write(ws);
  return next;
}
function setViewport(patch = {}) {
  const ws = read();
  ws.viewport = {
    x: finite(patch.x, ws.viewport.x), y: finite(patch.y, ws.viewport.y),
    zoom: finite(patch.zoom, ws.viewport.zoom, 0.01, 128),
  };
  write(ws); return ws.viewport;
}

/** Apply a reversible, workspace-only action and return its inverse. */
function applyAction(action = {}) {
  const type = action.type;
  const ws = read();
  const targetId = action.targetId ? assertId(action.targetId) : null;
  const payload = action.payload && typeof action.payload === 'object' ? action.payload : {};
  let obj = targetId ? getObject(ws, targetId) : null;

  if (['move_panel', 'dock_panel', 'open_panel', 'close_panel'].includes(type) && !obj) {
    throw new HttpError(404, `unknown workspace object "${targetId || ''}"`);
  }
  if (obj && obj.locked && type === 'move_panel') throw new HttpError(409, 'workspace object is locked');

  let inverse;
  if (type === 'move_panel') {
    inverse = { type, targetId, payload: { x: obj.x, y: obj.y, width: obj.width, height: obj.height, rotation: obj.rotation, scale: obj.scale } };
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'scale']) {
      if (payload[key] !== undefined) obj[key] = finite(payload[key], obj[key], key === 'width' || key === 'height' ? 40 : (key === 'scale' ? 0.05 : -10000000), key === 'scale' ? 64 : 10000000);
    }
    obj.dock = null;
  } else if (type === 'dock_panel') {
    inverse = { type, targetId, payload: { dock: obj.dock } };
    const dock = payload.dock == null ? null : payload.dock;
    if (dock !== null && !DOCKS.has(dock)) throw new HttpError(400, 'invalid dock position');
    obj.dock = dock;
  } else if (type === 'open_panel') {
    inverse = { type: obj.visible ? 'open_panel' : 'close_panel', targetId, payload: { collapsed: obj.collapsed } };
    obj.visible = true; obj.collapsed = Boolean(payload.collapsed);
  } else if (type === 'close_panel') {
    inverse = { type: 'open_panel', targetId, payload: { collapsed: obj.collapsed } };
    obj.visible = false;
  } else if (type === 'focus') {
    inverse = { type: 'focus', targetId: ws.activeObjectId, payload: {} };
    if (targetId && !obj) throw new HttpError(404, `unknown workspace object "${targetId}"`);
    ws.activeObjectId = targetId;
  } else {
    throw new HttpError(400, `workspace cannot execute action "${type}"`);
  }

  if (obj) obj.updatedAt = now();
  write(ws);
  return { workspace: ws, object: obj, inverse };
}

module.exports = {
  DATA_DIR, WORKSPACE_PATH, OBJECT_TYPES, DOCKS, emptyWorkspace, read, write,
  upsertObject, setViewport, applyAction,
};
