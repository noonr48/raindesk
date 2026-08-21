'use strict';

/**
 * Persistent spatial workspace model for the freeform Raindesk desk (v3).
 *
 * Visual-style agnostic. The workspace owns SPATIAL state only — window
 * frames, groups, shelf, viewport, focus. Creative content (strokes, images,
 * beats, candidates) lives in the document systems and is referenced softly
 * through `entityRef`; the workspace never verifies targets exist.
 *
 * v3 (freeform desk): windows[] + groups[] + shelf + monotonic `revision`.
 * Structural writes (window create/delete, group/shelf changes) accept
 * `baseRevision` and fail 409 with the current state when stale; spatial
 * updates stay last-write-wins. Migration is server-side in read() with a
 * one-time .bak backup; unknown schema versions fail closed.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const WORKSPACE_PATH = path.join(DATA_DIR, 'workspace.json');
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const WINDOW_TYPES = new Set([
  'sheet', 'shot', 'comic_page', 'reference_board', 'character_canvas', 'note',
  'sequence_strip', 'layers_panel', 'beat_trail', 'partner_panel', 'generic_panel',
]);
const DOCKS = new Set(['top', 'right', 'bottom', 'left']);
const SPACES = new Set(['screen', 'world']);
const SCREEN_TYPES = new Set(['layers_panel', 'beat_trail', 'partner_panel', 'generic_panel', 'sequence_strip']);
const STATES = new Set(['floating', 'tabbed', 'docked', 'minimised', 'maximised']);
// Soft entity references: typed prefix + bounded id segment. Existing data
// crosses prefixes (reference_board windows reference sheet: ids), so the
// prefix set is permissive, not type-locked.
const ENTITY_REF_RE = /^(sheet|shot|comic_page|character|note|board|partner|beats|layers|scenes|takes):[A-Za-z0-9_.-]{1,96}$/;
const WINDOW_FIELDS = new Set([
  'windowId', 'type', 'space', 'entityRef', 'x', 'y', 'width', 'height',
  'rotation', 'scale', 'zIndex', 'state', 'groupId', 'collapsed', 'pinned', 'locked', 'dock',
]);

function now() { return new Date().toISOString(); }
function emptyWorkspace() {
  return {
    schemaVersion: 3,
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    activeWindowId: null,
    windows: [],
    groups: [],
    shelf: { windowIds: [] },
    createdAt: now(), updatedAt: now(),
  };
}
function atomicWrite(value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${WORKSPACE_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, WORKSPACE_PATH);
}
function write(ws) { ws.revision = (ws.revision || 1) + 1; ws.updatedAt = now(); atomicWrite(ws); return ws; }

/* ------------------------------------------------------------- validation */

function assertId(id, what = 'workspace id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new HttpError(400, `bad ${what}`);
  return id;
}
function finite(value, fallback, min = -10000000, max = 10000000) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/** Strict v3 window sanitizer: unknown structural fields are REJECTED (the
 * v2 sanitizer silently dropped them, which loses group/shelf writes). */
function sanitizeWindow(input = {}, existing = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'window must be an object');
  const extra = Object.keys(input).find((key) => !WINDOW_FIELDS.has(key));
  if (extra) throw new HttpError(400, `window contains unsupported field ${extra}`);
  const windowId = assertId(input.windowId || (existing && existing.windowId), 'window id');
  const type = WINDOW_TYPES.has(input.type) ? input.type : (existing && existing.type) || 'generic_panel';
  const inheritedSpace = existing && SPACES.has(existing.space) ? existing.space : defaultSpaceForType(type);
  const space = SPACES.has(input.space) ? input.space : inheritedSpace;
  const rawRef = input.entityRef !== undefined ? input.entityRef : (existing && existing.entityRef) || null;
  if (rawRef != null && !ENTITY_REF_RE.test(String(rawRef))) throw new HttpError(400, 'window entityRef is not a typed reference');
  const rawState = input.state !== undefined ? input.state : (existing && existing.state) || 'floating';
  if (!STATES.has(rawState)) throw new HttpError(400, 'window state must be floating|tabbed|docked|minimised|maximised');
  const rawGroup = input.groupId !== undefined ? input.groupId : (existing && existing.groupId) || null;
  if (rawGroup != null && !ID_RE.test(String(rawGroup))) throw new HttpError(400, 'bad window groupId');
  return {
    windowId, type, space,
    entityRef: rawRef == null ? null : String(rawRef),
    x: finite(input.x, existing ? existing.x : 0),
    y: finite(input.y, existing ? existing.y : 0),
    width: finite(input.width, existing ? existing.width : 360, 40, 20000),
    height: finite(input.height, existing ? existing.height : 260, 40, 20000),
    rotation: finite(input.rotation, existing ? existing.rotation : 0, -360000, 360000),
    scale: finite(input.scale, existing ? existing.scale : 1, 0.05, 64),
    zIndex: finite(input.zIndex, existing ? existing.zIndex : 0, -100000, 100000),
    state: rawState,
    groupId: rawGroup == null ? null : String(rawGroup),
    collapsed: input.collapsed !== undefined ? Boolean(input.collapsed) : Boolean(existing && existing.collapsed),
    pinned: input.pinned !== undefined ? Boolean(input.pinned) : Boolean(existing && existing.pinned),
    locked: input.locked !== undefined ? Boolean(input.locked) : Boolean(existing && existing.locked),
    dock: space === 'world' ? null : (input.dock === null ? null : (DOCKS.has(input.dock) ? input.dock : (existing && existing.dock) || null)),
    updatedAt: now(),
  };
}

/** Whole-store referential integrity after any mutation, before write. */
function validateWorkspace(ws) {
  const ids = new Set();
  for (const win of ws.windows) {
    if (!win || !ID_RE.test(win.windowId)) throw new HttpError(500, 'workspace window identity is malformed');
    if (ids.has(win.windowId)) throw new HttpError(500, 'workspace window ids are not unique');
    ids.add(win.windowId);
  }
  const seenGroups = new Set();
  for (const group of ws.groups) {
    if (!group || !ID_RE.test(group.groupId)) throw new HttpError(500, 'workspace group identity is malformed');
    if (seenGroups.has(group.groupId)) throw new HttpError(500, 'workspace group ids are not unique');
    seenGroups.add(group.groupId);
    const members = Array.isArray(group.windowIds) ? group.windowIds : [];
    if (!members.length || new Set(members).size !== members.length) throw new HttpError(500, 'workspace group membership is empty or duplicated');
    for (const id of members) {
      if (!ids.has(id)) throw new HttpError(500, `workspace group references unknown window ${id}`);
    }
    if (group.activeWindowId != null && !members.includes(group.activeWindowId)) {
      throw new HttpError(500, 'workspace group active window is not a member');
    }
  }
  for (const win of ws.windows) {
    if (win.groupId != null && !seenGroups.has(win.groupId)) {
      throw new HttpError(500, `window ${win.windowId} references unknown group ${win.groupId}`);
    }
  }
  const shelf = ws.shelf && Array.isArray(ws.shelf.windowIds) ? ws.shelf.windowIds : [];
  if (new Set(shelf).size !== shelf.length) throw new HttpError(500, 'workspace shelf contains duplicates');
  for (const id of shelf) {
    if (!ids.has(id)) throw new HttpError(500, `workspace shelf references unknown window ${id}`);
  }
  if (ws.activeWindowId != null && !ids.has(ws.activeWindowId)) {
    throw new HttpError(500, 'workspace active window does not exist');
  }
}

function assertBaseRevision(ws, options = {}) {
  if (options && options.baseRevision != null && Number(options.baseRevision) !== ws.revision) {
    throw Object.assign(new HttpError(409, 'workspace changed since this edit'), { workspace: ws });
  }
}

/* ------------------------------------------------------------- migration */

function defaultSpaceForType(type) { return SCREEN_TYPES.has(type) ? 'screen' : 'world'; }

function migrateV1toV2(ws) {
  ws.schemaVersion = 2;
  ws.objects = (ws.objects || []).map((obj) => ({
    ...obj,
    space: obj && obj.space === 'world' ? 'world' : defaultSpaceForType(obj && obj.type),
  }));
  return ws;
}

/** v2 objects → v3 windows. Put-away world sheets become `tabbed` (they live
 * in the desk tab strip); hidden screen panels become `minimised` (shelf).
 * Existing groupIds synthesize groups; dock and activeObjectId carry over. */
function migrateV2toV3(ws) {
  try { fs.copyFileSync(WORKSPACE_PATH, `${WORKSPACE_PATH}.v2.bak`); } catch (_e) { /* best-effort backup */ }
  const windows = (ws.objects || []).map((obj) => {
    const space = obj.space === 'world' ? 'world' : 'screen';
    let state = 'floating';
    if (obj.visible === false) state = space === 'world' ? 'tabbed' : 'minimised';
    else if (space === 'screen' && obj.dock && DOCKS.has(obj.dock)) state = 'docked';
    return {
      windowId: assertId(obj.id, 'window id'),
      type: WINDOW_TYPES.has(obj.type) ? obj.type : 'generic_panel',
      space,
      entityRef: obj.entityRef || null,
      x: finite(obj.x, 0), y: finite(obj.y, 0),
      width: finite(obj.width, 360, 40, 20000), height: finite(obj.height, 260, 40, 20000),
      rotation: finite(obj.rotation, 0, -360000, 360000), scale: finite(obj.scale, 1, 0.05, 64),
      zIndex: finite(obj.zIndex, 0, -100000, 100000),
      state,
      groupId: obj.groupId || null,
      collapsed: Boolean(obj.collapsed),
      pinned: false,
      locked: Boolean(obj.locked),
      dock: space === 'screen' && obj.dock && DOCKS.has(obj.dock) ? obj.dock : null,
      updatedAt: now(),
    };
  });
  const groupMap = new Map();
  for (const win of windows) {
    if (win.groupId == null) continue;
    if (!groupMap.has(win.groupId)) groupMap.set(win.groupId, []);
    groupMap.get(win.groupId).push(win.windowId);
  }
  const groups = [...groupMap.entries()].map(([groupId, windowIds]) => ({ groupId, windowIds, activeWindowId: windowIds[windowIds.length - 1] }));
  const migrated = {
    schemaVersion: 3,
    revision: 1,
    viewport: ws.viewport || { x: 0, y: 0, zoom: 1 },
    activeWindowId: ws.activeObjectId || null,
    windows,
    groups,
    shelf: { windowIds: windows.filter((w) => w.state === 'minimised').map((w) => w.windowId) },
    createdAt: ws.createdAt || now(), updatedAt: now(),
  };
  validateWorkspace(migrated);
  atomicWrite(migrated);
  return migrated;
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
  if (!ws || typeof ws !== 'object' || !ws.viewport) throw new HttpError(500, 'workspace state is malformed');
  if (ws.schemaVersion === 1) { ws = migrateV1toV2(ws); write(ws); }
  if (ws.schemaVersion === 2) { ws = migrateV2toV3(ws); return ws; }
  if (ws.schemaVersion !== 3 || !Array.isArray(ws.windows) || !Array.isArray(ws.groups)) {
    throw new HttpError(500, 'workspace state is malformed');
  }
  if (!ws.shelf || !Array.isArray(ws.shelf.windowIds)) ws.shelf = { windowIds: [] };
  if (!ws.revision || !Number.isFinite(ws.revision)) ws.revision = 1;
  return ws;
}

/** Client envelope for GET /api/workspace during migration: canonical v3
 * shape plus a derived v2 `objects` projection so pre-v3 clients
 * (WorkspaceShell, CreativeDesk) keep working unchanged. */
function readClient() {
  const ws = read();
  return { ...ws, objects: legacyObjects(ws) };
}

/* --------------------------------------------------------------- v3 API */

function getWindow(ws, windowId) { return ws.windows.find((w) => w && w.windowId === windowId) || null; }

function upsertWindow(input, options = {}) {
  const ws = read();
  assertBaseRevision(ws, options);
  const windowId = assertId(input && input.windowId, 'window id');
  const existing = getWindow(ws, windowId);
  const next = sanitizeWindow(input, existing);
  if (existing) Object.assign(existing, next); else ws.windows.push(next);
  validateWorkspace(ws);
  write(ws);
  return next;
}

function deleteWindow(windowId, options = {}) {
  const ws = read();
  assertBaseRevision(ws, options);
  const id = assertId(windowId, 'window id');
  const before = ws.windows.length;
  ws.windows = ws.windows.filter((w) => w.windowId !== id);
  if (ws.windows.length === before) throw new HttpError(404, `unknown workspace window "${id}"`);
  for (const group of ws.groups) {
    group.windowIds = group.windowIds.filter((wid) => wid !== id);
    if (group.activeWindowId === id) group.activeWindowId = group.windowIds[0] || null;
  }
  ws.groups = ws.groups.filter((group) => group.windowIds.length > 0);
  ws.shelf.windowIds = ws.shelf.windowIds.filter((wid) => wid !== id);
  if (ws.activeWindowId === id) ws.activeWindowId = null;
  validateWorkspace(ws);
  write(ws);
  return ws;
}

function setGroups(groups, options = {}) {
  const ws = read();
  assertBaseRevision(ws, options);
  if (!Array.isArray(groups)) throw new HttpError(400, 'groups must be an array');
  const clean = groups.map((group) => {
    if (!group || typeof group !== 'object') throw new HttpError(400, 'group must be an object');
    const extra = Object.keys(group).find((key) => !['groupId', 'windowIds', 'activeWindowId'].includes(key));
    if (extra) throw new HttpError(400, `group contains unsupported field ${extra}`);
    const groupId = assertId(group.groupId, 'group id');
    if (!Array.isArray(group.windowIds) || !group.windowIds.length) throw new HttpError(400, 'group windowIds must be a non-empty array');
    const windowIds = group.windowIds.map((id) => assertId(id, 'group window id'));
    if (group.activeWindowId != null) assertId(group.activeWindowId, 'group active window id');
    return { groupId, windowIds, activeWindowId: group.activeWindowId || null };
  });
  // Windows not named by any group lose their groupId; named windows gain it.
  const membership = new Map();
  for (const group of clean) for (const id of group.windowIds) membership.set(id, group.groupId);
  for (const win of ws.windows) win.groupId = membership.get(win.windowId) || null;
  ws.groups = clean;
  validateWorkspace(ws);
  write(ws);
  return ws;
}

function setShelf(windowIds, options = {}) {
  const ws = read();
  assertBaseRevision(ws, options);
  if (!Array.isArray(windowIds)) throw new HttpError(400, 'shelf windowIds must be an array');
  ws.shelf = { windowIds: windowIds.map((id) => assertId(id, 'shelf window id')) };
  validateWorkspace(ws);
  write(ws);
  return ws;
}

function setViewport(patch = {}) {
  const ws = read();
  ws.viewport = {
    x: finite(patch.x, ws.viewport.x), y: finite(patch.y, ws.viewport.y),
    zoom: finite(patch.zoom, ws.viewport.zoom, 0.01, 128),
  };
  write(ws); return ws.viewport;
}

/* --------------------------------------------- v2-compatible object layer */

/** Legacy object projection for pre-v3 clients (WorkspaceShell, CreativeDesk,
 * Partner actions). Derived, never stored. */
function toLegacyObject(win) {
  return {
    ...win,
    id: win.windowId,
    visible: win.state !== 'minimised' && win.state !== 'tabbed',
    collapsed: win.state === 'minimised' ? true : win.collapsed,
  };
}
function legacyObjects(ws) { return ws.windows.map(toLegacyObject); }

/** Legacy upsert: accepts v2 field names (id, visible, collapsed) and maps
 * them onto v3 window state. Keeps old clients functional during migration. */
function upsertObject(input = {}) {
  const mapped = { ...input };
  if (mapped.id !== undefined) { mapped.windowId = mapped.id; delete mapped.id; }
  if (mapped.visible !== undefined || mapped.collapsed !== undefined) {
    const existing = getWindow(read(), mapped.windowId);
    const space = mapped.space || (existing && existing.space) || defaultSpaceForType(mapped.type || (existing && existing.type));
    if (mapped.visible === false) mapped.state = space === 'world' ? 'tabbed' : 'minimised';
    else if (mapped.visible === true) mapped.state = (space === 'screen' && mapped.dock && DOCKS.has(mapped.dock)) ? 'docked' : 'floating';
    delete mapped.visible;
    if (mapped.collapsed === undefined && mapped.state === 'minimised') mapped.collapsed = true;
  }
  // Legacy clients may send unknown-to-v3 keys implicitly via spread — strip
  // nothing silently for structural fields; allow only the known legacy set.
  const LEGACY_IN = new Set([...WINDOW_FIELDS, 'id', 'visible']);
  const unexpected = Object.keys(mapped).find((key) => !LEGACY_IN.has(key));
  if (unexpected) throw new HttpError(400, `workspace object contains unsupported field ${unexpected}`);
  return toLegacyObject(upsertWindow(mapped));
}

/** Apply a reversible, workspace-only action and return its inverse.
 * v2 action names retained; they operate on v3 windows. */
function applyAction(action = {}) {
  const type = action.type;
  const ws = read();
  const targetId = action.targetId ? assertId(action.targetId) : null;
  const payload = action.payload && typeof action.payload === 'object' ? action.payload : {};
  let win = targetId ? getWindow(ws, targetId) : null;

  if (['move_panel', 'dock_panel', 'open_panel', 'close_panel'].includes(type) && !win) {
    throw new HttpError(404, `unknown workspace object "${targetId || ''}"`);
  }
  if (win && win.locked && type === 'move_panel') throw new HttpError(409, 'workspace object is locked');

  let inverse;
  if (type === 'move_panel') {
    inverse = { type, targetId, payload: { x: win.x, y: win.y, width: win.width, height: win.height, rotation: win.rotation, scale: win.scale, dock: win.dock } };
    for (const key of ['x', 'y', 'width', 'height', 'rotation', 'scale']) {
      if (payload[key] !== undefined) win[key] = finite(payload[key], win[key], key === 'width' || key === 'height' ? 40 : (key === 'scale' ? 0.05 : -10000000), key === 'scale' ? 64 : 10000000);
    }
    if (payload.dock === undefined) win.dock = null;
    else if (payload.dock === null || DOCKS.has(payload.dock)) win.dock = payload.dock;
    else throw new HttpError(400, 'invalid dock position');
    if (win.space === 'screen' && win.dock && win.state !== 'minimised') win.state = 'docked';
    else if (!win.dock && win.state === 'docked') win.state = 'floating';
  } else if (type === 'dock_panel') {
    if (win.space === 'world') throw new HttpError(400, 'world objects do not use screen-edge docking');
    inverse = { type, targetId, payload: { dock: win.dock } };
    const dock = payload.dock == null ? null : payload.dock;
    if (dock !== null && !DOCKS.has(dock)) throw new HttpError(400, 'invalid dock position');
    win.dock = dock;
    if (win.state !== 'minimised') win.state = dock ? 'docked' : 'floating';
  } else if (type === 'open_panel') {
    inverse = { type: win.state === 'minimised' || win.state === 'tabbed' ? 'open_panel' : 'close_panel', targetId, payload: { collapsed: win.collapsed } };
    win.state = (win.space === 'screen' && win.dock) ? 'docked' : 'floating';
    win.collapsed = Boolean(payload.collapsed);
    ws.shelf.windowIds = ws.shelf.windowIds.filter((id) => id !== win.windowId);
  } else if (type === 'close_panel') {
    inverse = { type: 'open_panel', targetId, payload: { collapsed: win.collapsed } };
    win.state = win.space === 'world' ? 'tabbed' : 'minimised';
    if (win.space === 'screen' && !ws.shelf.windowIds.includes(win.windowId)) ws.shelf.windowIds.push(win.windowId);
  } else if (type === 'focus') {
    inverse = { type: 'focus', targetId: ws.activeWindowId, payload: {} };
    if (targetId && !win) throw new HttpError(404, `unknown workspace object "${targetId}"`);
    ws.activeWindowId = targetId;
  } else {
    throw new HttpError(400, `workspace cannot execute action "${type}"`);
  }

  if (win) win.updatedAt = now();
  validateWorkspace(ws);
  write(ws);
  return { workspace: ws, object: win ? toLegacyObject(win) : null, inverse };
}

module.exports = {
  DATA_DIR, WORKSPACE_PATH, OBJECT_TYPES: WINDOW_TYPES, WINDOW_TYPES, DOCKS, SPACES, SCREEN_TYPES, STATES, ENTITY_REF_RE, WINDOW_FIELDS,
  defaultSpaceForType, emptyWorkspace, read, readClient, write, validateWorkspace,
  upsertWindow, deleteWindow, setGroups, setShelf, setViewport,
  toLegacyObject, legacyObjects, upsertObject, applyAction,
};
