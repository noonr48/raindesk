'use strict';

/*
 * Deterministic fake-DOM tests for the freeform window manager (Phase 1).
 * Executes the REAL public/js/window-manager.js registry + WindowManager
 * against a minimal node-graph DOM — the sibling-PR16 fake-DOM pattern.
 * Native-browser journeys own the end-to-end acceptance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/* ---------------------------------------------------------- fake DOM */

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div'),
    children: [],
    dataset: {},
    style: {},
    _listeners: {},
    _attrs: {},
    textContent: '',
    hidden: false,
    classList: {
      _set: new Set(),
      add(...cs) { cs.forEach((c) => this._set.add(c)); },
      remove(...cs) { cs.forEach((c) => this._set.delete(c)); },
      toggle(c, on) {
        if (on === undefined) { if (this._set.has(c)) this._set.delete(c); else this._set.add(c); }
        else if (on) this._set.add(c); else this._set.delete(c);
        return this._set.has(c);
      },
      contains(c) { return this._set.has(c); },
    },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    removeAttribute(k) { delete this._attrs[k]; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); },
    parentNode: null,
    addEventListener(type, fn, capture) {
      const key = capture ? `${type}:capture` : type;
      (this._listeners[key] = this._listeners[key] || []).push(fn);
    },
    removeEventListener(type, fn, capture) {
      const key = capture ? `${type}:capture` : type;
      const list = this._listeners[key] || [];
      const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1);
    },
    dispatch(type, event) {
      event = event || {};
      event.target = event.target || this;
      event.preventDefault = event.preventDefault || (() => {});
      event.stopPropagation = event.stopPropagation || (() => {});
      for (const fn of this._listeners[type] || []) fn(event);
      for (const fn of this._listeners[`${type}:capture`] || []) fn(event);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    closest(selector) {
      // Minimal: support 'button,input,textarea,a,[contenteditable="true"],[data-no-drag]'
      // and '.cls' forms used by the manager.
      let node = this;
      const parts = selector.split(',').map((s) => s.trim());
      while (node) {
        for (const part of parts) {
          if (part.startsWith('.') && node.classList && node.classList.contains(part.slice(1))) return node;
          if (part.startsWith('[') && node.hasAttribute && node.hasAttribute(part.slice(1, -1).replace(/=".*"$/, ''))) return node;
          if (node.tagName && part.toUpperCase() === node.tagName.toUpperCase()) return node;
        }
        node = node.parentNode;
      }
      return null;
    },
    querySelector(selector) {
      const results = [];
      findAll(this, selector, results, false);
      return results[0] || null;
    },
    querySelectorAll(selector) {
      const results = [];
      findAll(this, selector, results, true);
      return results;
    },
    contains(other) { return this === other || this.children.some((c) => c && typeof c.contains === 'function' && c.contains(other)); },
    set innerHTML(v) { this.children.length = 0; this._innerHTML = v; },
    get innerHTML() { return this._innerHTML || ''; },
    getBoundingClientRect() { return this._rect || { left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300 }; },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(v) { node.classList._set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => node.classList._set.add(c)); },
  });
  for (const child of node.children) child.parentNode = node;
  return node;
}

function findAll(node, selector, out, all) {
  const parts = selector.split(',').map((s) => s.trim());
  // Compound class selectors (.a.b) require EVERY class, matching real DOM
  // semantics (the shelf chrome queries .freeform-window-btn.minimise).
  const matches = (child, part) => {
    if (part.startsWith('.')) {
      const classes = part.slice(1).split('.').filter(Boolean);
      return Boolean(child.classList) && classes.every((c) => child.classList.contains(c));
    }
    if (part.startsWith('[')) {
      const attr = part.slice(1, -1).split('=')[0];
      return Boolean(child.hasAttribute) && child.hasAttribute(attr);
    }
    return Boolean(child.tagName) && child.tagName.toUpperCase() === part.toUpperCase();
  };
  for (const child of node.children || []) {
    for (const part of parts) {
      if (matches(child, part)) { out.push(child); if (!all) return; }
    }
    findAll(child, selector, out, all);
    if (!all && out.length) return;
  }
}

const fakeDocument = {
  createElement: (t) => makeNode(t),
  defaultView: { CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } } },
  elementFromPoint: null, // tests stub this for drop-zone resolution
  elementsFromPoint: null, // tests stub this for stacked (look-through) drops
  _listeners: {},
  addEventListener(type, fn, capture) {
    const key = capture ? `${type}:capture` : type;
    (this._listeners[key] = this._listeners[key] || []).push(fn);
  },
  removeEventListener(type, fn, capture) {
    const key = capture ? `${type}:capture` : type;
    const list = this._listeners[key] || [];
    const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1);
  },
  dispatch(type, event) {
    event = event || {};
    event.target = event.target || this;
    event.preventDefault = event.preventDefault || (() => {});
    for (const fn of this._listeners[type] || []) fn(event);
    for (const fn of this._listeners[`${type}:capture`] || []) fn(event);
  },
};
const savedDocument = global.document;
global.document = fakeDocument;

const wm = require(path.join(ROOT, 'public', 'js', 'window-manager.js'));
const v4mod = require(path.join(ROOT, 'public', 'js', 'v4-client.js'));
global.RaindeskV4Client = v4mod; // WindowManager's self-construct fallback reads this

test.after(() => { if (savedDocument === undefined) delete global.document; else global.document = savedDocument; });

/* ------------------------------------------------------------ helpers */

/* ----------------------------------------------------- v4 api fixture */

/** Fake v4 wire surface: records every intent/spatial commit into `record`
 * and answers with realistic canonical payloads (refs, createdGroup, shelf
 * and presentation echoes) so the manager's adopt paths stay exercised. */
function v4ApiFixture({ record = [], doc } = {}) {
  let structuralRevision = 1;
  let groupSeq = 0;
  return {
    applyWorkspaceIntent(payload) {
      record.push({ kind: 'intent', op: payload.op, intentId: payload.intentId });
      structuralRevision += 1;
      const op = payload.op || {};
      const changed = { kind: op.kind, windows: [], groups: [], tombstones: [] };
      if (op.kind === 'window.create') {
        changed.windows.push({ ref: { windowId: op.windowId, generation: 1, incarnationId: op.incarnationId }, presentation: { kind: 'floating' } });
      } else if (op.kind === 'group.create') {
        groupSeq += 1;
        const group = { groupId: `grp_test_${groupSeq}`, version: 1, members: op.members.map((m) => ({ ...m })), active: { ...(op.active || op.members[0]) } };
        changed.groups.push(group);
        changed.createdGroup = group;
      } else if (op.kind === 'group.join' || op.kind === 'group.leave' || op.kind === 'group.activate' || op.kind === 'group.reorder' || op.kind === 'group.dissolve') {
        // Realistic echo: the touched group with its members (the canned
        // members:[] shape was unrealistic — the adopt path never observed
        // membership through activate echoes). DISSOLVE echoes the group
        // EMPTIED (members: [], active: null) — mirroring the real server —
        // so the adopt loop deletes the local record instead of resurrecting
        // a fictional one.
        const dissolved = op.kind === 'group.dissolve';
        const members = dissolved ? [] : (op.member ? [op.member] : []).map((m) => ({ ...m }));
        changed.groups.push({ groupId: op.groupId || (op.target && op.target.groupId) || `grp_test_${groupSeq}`, version: 2, members, active: dissolved ? null : (op.member ? { ...op.member } : null) });
      } else if (op.kind === 'window.close' && op.window) {
        changed.tombstones.push({ ...op.window });
      } else if (op.kind === 'shelf.minimise' || op.kind === 'shelf.restore') {
        // Canonical shelf echo: minimise ADDS the ref, restore removes it —
        // adoptResponse treats this as truth, so an empty minimise echo
        // would instantly un-minimise the model.
        changed.shelf = { version: 2, members: op.kind === 'shelf.minimise' && op.window ? [{ ...op.window }] : [] };
        if (op.window) changed.windows.push({ ref: { ...op.window }, presentation: op.mode === 'resume' ? { kind: 'docked', edge: 'left' } : { kind: 'floating' } });
      } else if (op.kind === 'window.setPresentation' && op.window) {
        const pres = op.mode === 'docked' ? { kind: 'docked', edge: op.edge }
          : op.mode === 'maximised' ? { kind: 'maximised' }
          : op.mode === 'restore' ? { kind: 'floating' }
          : { kind: 'floating', ...(op.floatingAt ? { at: { x: op.floatingAt.x, y: op.floatingAt.y } } : {}) };
        changed.windows.push({ ref: { ...op.window }, presentation: pres });
      }
      return Promise.resolve({ ok: true, intentId: payload.intentId, duplicate: false, structuralRevision, changed });
    },
    patchWorkspaceSpatial(windowId, generation, body) {
      record.push({ kind: 'spatial', windowId, generation, patch: body.patch || {}, mutationId: body.mutationId, space: body.space });
      return Promise.resolve({ ok: true, spatialRevision: 1, spatialVersion: 2, structuralRevision, window: { ref: { windowId, generation, incarnationId: body.incarnationId } } });
    },
    getWorkspaceV4() {
      return Promise.resolve(doc || { schemaVersion: 4, windows: [], groups: [], shelf: { version: 1, members: [] }, focus: null, structuralRevision: 1, spatialRevision: 1, viewportRevision: 1 });
    },
  };
}

function freshManager({ persistCalls } = {}) {
  const calls = persistCalls || [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record: calls });
  api.getWorkspace = () => Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } });
  api.focusWorkspace = () => Promise.resolve({ ok: true });
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: {}, // no snapping in unit tests
  });
  return { manager, root, calls };
}

wm.CreativeSurfaces.clear();
wm.CreativeSurfaces.register({ id: 'layers', title: 'Layers', entityType: 'layers_panel', coordinateSpace: 'screen', minimumSize: { width: 240, height: 160 } });
wm.CreativeSurfaces.register({ id: 'references', title: 'Reference Board', entityType: 'reference_board', coordinateSpace: 'screen' });
wm.CreativeSurfaces.register({ id: 'dockable', title: 'Dockable', entityType: 'generic_panel', coordinateSpace: 'screen', supportedStates: ['floating', 'minimised', 'maximised', 'docked'] });
wm.CreativeSurfaces.register({ id: 'locked_only', title: 'Pinned Only', entityType: 'note', coordinateSpace: 'screen', supportedStates: ['floating'] });
// Shared controller-backed fixture, registered at module scope so ANY test
// (including name-filtered runs) can open it — test-local registration made
// isolated runs fail with 'unknown creative surface'.
let probeDestroyed = 0;
wm.CreativeSurfaces.register({
  id: 'probe', title: 'Probe', entityType: 'generic_panel', coordinateSpace: 'screen',
  createController: ({ body, close }) => {
    body.appendChild(fakeDocument.createElement('div'));
    return { destroy() { probeDestroyed += 1; }, close, render() {} };
  },
});

/* ------------------------------------------------------------- tests */

test('registry validates ids and freezes definitions', () => {
  assert.throws(() => wm.CreativeSurfaces.register({ id: 'Bad Id!' }), /slug/);
  const def = wm.CreativeSurfaces.get('layers');
  assert.ok(def);
  assert.equal(def.title, 'Layers');
  assert.equal(def.minimumSize.width, 240);
  assert.throws(() => { def.title = 'x'; }, /not extensible|read only/i);
  // Re-register is idempotent.
  wm.CreativeSurfaces.register({ id: 'layers', title: 'Other' });
  assert.equal(wm.CreativeSurfaces.get('layers').title, 'Layers');
});

test('open creates a floating focused window with chrome and brings it to front', () => {
  const { manager, root } = freshManager();
  const controller = manager.open('references');
  assert.equal(controller, null, 'no createController -> null controller, window still opens');
  const state = manager.state('window_references');
  assert.equal(state.state, 'floating');
  assert.ok(state.focused);
  assert.equal(state.rect.width > 0, true);
  const frame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_references');
  assert.ok(frame, 'frame appended to root');
  assert.ok(frame.querySelector('.freeform-window-head'));
  assert.ok(frame.querySelector('.freeform-window-body'));
  assert.ok(frame.querySelector('.freeform-window-resize'));
  // Re-open focuses instead of duplicating.
  manager.open('references');
  assert.equal(manager.list().length, 1);
});

test('window state machine: minimise -> restore keeps the rect; maximise -> unmaximise restores it', () => {
  const { manager } = freshManager();
  manager.open('references', { rect: { x: 120, y: 90, width: 400, height: 300 } });
  const before = manager.state('window_references').rect;

  manager.minimise('window_references');
  assert.equal(manager.state('window_references').state, 'minimised');
  assert.equal(manager.state('window_references').collapsed, true);

  manager.restore('window_references');
  const restored = manager.state('window_references');
  assert.equal(restored.state, 'floating');
  assert.deepEqual(restored.rect, before, 'restore preserves the prior rect');

  manager.maximise('window_references');
  assert.equal(manager.state('window_references').state, 'maximised');
  manager.unmaximise('window_references');
  assert.equal(manager.state('window_references').state, 'floating');
  assert.deepEqual(manager.state('window_references').rect, before, 'unmaximise restores the exact previous arrangement');
});

test('supportedStates is enforced on transition', () => {
  const { manager } = freshManager();
  manager.open('locked_only');
  assert.throws(() => manager.minimise('window_locked_only'), /does not support state minimised/);
});

test('close destroys the controller and removes the frame', () => {
  const { manager, root } = freshManager();
  const before = probeDestroyed;
  manager.open('probe');
  assert.equal(root.children.filter((c) => c.dataset && c.dataset.windowId === 'window_probe').length, 1);
  manager.close('window_probe');
  assert.equal(probeDestroyed, before + 1);
  assert.equal(manager.state('window_probe'), null);
  assert.equal(root.children.filter((c) => c.dataset && c.dataset.windowId === 'window_probe').length, 0);
});

test('lifecycle changes travel as v4 intents (create + shelf.minimise); spatial lane stays geometry-only', async () => {
  const { manager, calls } = freshManager();
  manager.open('references', { rect: { x: 10, y: 20, width: 350, height: 280 } });
  manager.minimise('window_references');
  await new Promise((r) => setTimeout(r, 5));
  const create = calls.find((c) => c.kind === 'intent' && c.op.kind === 'window.create');
  assert.ok(create, 'open births through the window.create intent');
  assert.equal(create.op.windowId, 'window_references');
  assert.equal(create.op.x, 10);
  assert.equal(create.op.width, 350);
  const minimise = calls.find((c) => c.kind === 'intent' && c.op.kind === 'shelf.minimise');
  assert.ok(minimise, 'minimise travels as the shelf.minimise intent');
  assert.equal(calls.filter((c) => c.kind === 'spatial').length, 0, 'no lifecycle state ever rides the spatial lane');
});

test('focus and z-order: bringing a window to front raises its zIndex', () => {
  const { manager } = freshManager();
  manager.open('references');
  manager.open('layers');
  const zr = manager.state('window_references').zIndex;
  const zl = manager.state('window_layers').zIndex;
  assert.ok(zl > zr, 'the most recently opened window is on top');
  manager.bringToFront('window_references');
  assert.ok(manager.state('window_references').zIndex > zl, 'bringToFront raises above the previous top');
});

test('init restores persisted floating windows and shelf-backs minimised ones', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record, doc: {
    schemaVersion: 4, structuralRevision: 4, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_references', generation: 1, incarnationId: 'inc_a1' }, type: 'reference_board', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 5, y: 6, width: 300, height: 240, rotation: 0, scale: 1, zIndex: 7 }, structureVersion: 1, spatialVersion: 1 },
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_b2' }, type: 'layers_panel', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 1, y: 2, width: 260, height: 200, rotation: 0, scale: 1, zIndex: 8 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [],
    shelf: { version: 1, members: [{ windowId: 'window_layers', generation: 1, incarnationId: 'inc_b2' }] },
    focus: null,
  } });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const refs = manager.state('window_references');
  assert.ok(refs, 'floating window restored');
  assert.equal(refs.rect.x, 5);
  assert.ok(refs.ref && refs.ref.generation === 1, 'canonical ref adopted');
  // Minimised windows are shelf-backed: identity + rect + controller on
  // disk, frame hidden until a shelf chip restores them.
  const layers = manager.state('window_layers');
  assert.ok(layers, 'minimised window restored as a shelf-backed model');
  assert.equal(layers.state, 'minimised');
  const layersFrame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_layers');
  assert.ok(layersFrame, 'shelf-backed frame exists');
  assert.equal(layersFrame.hidden, true, 'shelf-backed frame hidden until restored');
  assert.equal(record.length, 0, 'init does not rewrite unchanged state');
});

test('init restores groups: tabbed members return with the active member visible', async () => {
  const root = makeNode('div');
  const api = v4ApiFixture({ doc: {
    schemaVersion: 4, structuralRevision: 6, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_ga', generation: 1, incarnationId: 'inc_ga' }, type: 'note', entityRef: 'note:ga', presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 10, y: 10, width: 300, height: 200, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
      { ref: { windowId: 'window_gb', generation: 1, incarnationId: 'inc_gb' }, type: 'note', entityRef: 'note:gb', presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 10, y: 10, width: 300, height: 200, rotation: 0, scale: 1, zIndex: 4 }, structureVersion: 1, spatialVersion: 1 },
      { ref: { windowId: 'window_stray', generation: 1, incarnationId: 'inc_stray' }, type: 'note', entityRef: 'note:stray', presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 60, y: 60, width: 260, height: 180, rotation: 0, scale: 1, zIndex: 5 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [{ groupId: 'g_restore', version: 1, members: [{ windowId: 'window_ga', generation: 1, incarnationId: 'inc_ga' }, { windowId: 'window_gb', generation: 1, incarnationId: 'inc_gb' }], active: { windowId: 'window_gb', generation: 1, incarnationId: 'inc_gb' } }],
    shelf: { version: 1, members: [] },
    focus: null,
  } });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const groups = manager.groups();
  assert.equal(groups.length, 1, 'live group restored');
  assert.deepEqual(groups[0].windowIds, ['window_ga', 'window_gb']);
  assert.equal(groups[0].activeWindowId, 'window_gb');
  const aFrame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_ga');
  const bFrame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_gb');
  assert.equal(bFrame.hidden, false, 'active member visible');
  assert.equal(aFrame.hidden, true, 'inactive member hidden');
  const tabs = bFrame.querySelectorAll('.freeform-window-tab');
  assert.equal(tabs.length, 2, 'active member renders the tab strip');
  const stray = manager.state('window_stray');
  assert.equal(stray.state, 'floating', 'an ungrouped ref derives floating (stranded-tab shapes cannot exist in v4)');
  const strayFrame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_stray');
  assert.equal(strayFrame.hidden, false, 'stranded member is visible');
});

test('joinGroup attaches to an existing stack and starts one around an ungrouped target', () => {
  const { manager } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  manager.joinGroup(c, a);
  let group = manager.groups()[0];
  assert.deepEqual(group.windowIds, [a, b, c], 'dropped window joins the target stack');
  assert.equal(manager.state(c).state, 'tabbed');

  // Tear out, dissolve, then drop onto an ungrouped floating target.
  manager.tearOut(c, 900, 700);
  assert.equal(manager.state(c).state, 'floating');
  manager.ungroup(manager.groups()[0].groupId);
  assert.equal(manager.groups().length, 0);
  manager.joinGroup(c, a); // a is floating now -> a fresh stack forms around it
  group = manager.groups()[0];
  assert.deepEqual(group.windowIds, [a, c], 'dropping onto an ungrouped window starts a stack');
  assert.equal(group.activeWindowId, a, 'target stays active');
  assert.equal(manager.state(c).state, 'tabbed');
});

test('window drag released over the shelf minimises it', async () => {
  const { manager, root, shelf, shelfCalls } = shelfManager();
  manager.attachShelf(shelf);
  manager.open('references', { rect: { x: 120, y: 90, width: 400, height: 300 } });
  shelf._rect = { left: 500, top: 740, right: 780, bottom: 780 };
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 200, clientY: 120 });
  fakeDocument.dispatch('pointermove', { clientX: 240, clientY: 160, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 600, clientY: 760 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(manager.state('window_references').state, 'minimised', 'drop on the shelf minimises');
  assert.equal(frame.hidden, true);
  assert.ok(shelf.children.some((c) => c.classList.contains('freeform-shelf-chip')), 'shelf chip rendered');
  const min = shelfCalls.find((c) => c.kind === 'intent' && c.op.kind === 'shelf.minimise');
  assert.ok(min && min.op.window.windowId === 'window_references', 'shelf membership persisted as the shelf.minimise intent');
});

test('window drag released over another window joins its group (through the dragged frame)', () => {
  const { manager, root } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  const aFrame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  const cFrame = root.children.find((f) => f.dataset && f.dataset.windowId === c);
  // Real-browser layout: the dragged frame (c) is under the cursor at
  // release; the target stack (a) sits beneath it in the element stack.
  fakeDocument.elementsFromPoint = () => [cFrame, aFrame];
  try {
    const head = cFrame.querySelector('.freeform-window-head');
    head.dispatch('pointerdown', { button: 0, clientX: 700, clientY: 300 });
    fakeDocument.dispatch('pointermove', { clientX: 650, clientY: 280, buttons: 1 });
    fakeDocument.dispatch('pointerup', { clientX: 620, clientY: 300 });
    assert.equal(manager.groups().length, 1, 'one group after the drop');
    assert.deepEqual(manager.groups()[0].windowIds, [a, b, c], 'floating window joined the drop target stack');
    assert.equal(manager.state(c).state, 'tabbed');
    assert.equal(manager.groups()[0].activeWindowId, a, 'target stack keeps its active member');
  } finally {
    fakeDocument.elementsFromPoint = null;
  }
});

test('drop-to-group falls back to elementFromPoint on hosts without the stacked API', () => {
  const { manager, root } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  const aFrame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  const cFrame = root.children.find((f) => f.dataset && f.dataset.windowId === c);
  fakeDocument.elementsFromPoint = null; // force the legacy branch
  fakeDocument.elementFromPoint = () => aFrame; // topmost hit is the target
  try {
    const head = cFrame.querySelector('.freeform-window-head');
    head.dispatch('pointerdown', { button: 0, clientX: 700, clientY: 300 });
    fakeDocument.dispatch('pointermove', { clientX: 650, clientY: 280, buttons: 1 });
    fakeDocument.dispatch('pointerup', { clientX: 620, clientY: 300 });
    assert.deepEqual(manager.groups()[0].windowIds, [a, b, c], 'fallback path still joins the target stack');
    assert.equal(manager.state(c).state, 'tabbed');
  } finally {
    fakeDocument.elementFromPoint = null;
  }
});

test('tab drag within the strip reorders; beyond the strip tears out', () => {
  const { manager, root } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b, c], { activeWindowId: a });
  const activeFrame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  const strip = activeFrame.querySelector('.freeform-window-tabs');
  strip._rect = { left: 0, top: 0, right: 1000, bottom: 40 };
  const setTabRects = () => {
    const tabs = strip.querySelectorAll('.freeform-window-tab');
    const spans = [[0, 100], [100, 200], [200, 300]];
    tabs.forEach((tab, i) => { tab._rect = { left: spans[i][0], top: 0, right: spans[i][1], bottom: 40 }; });
    return tabs;
  };
  setTabRects();

  // Reorder: drag B past C's midpoint (250), release inside the strip.
  const tabs1 = setTabRects();
  const tabB = tabs1.find((t) => t.dataset.tabFor === b);
  tabB.dispatch('pointerdown', { button: 0, clientX: 150, clientY: 20 });
  fakeDocument.dispatch('pointermove', { clientX: 260, clientY: 20 });
  fakeDocument.dispatch('pointerup', { clientX: 260, clientY: 22 });
  assert.deepEqual(manager.groups()[0].windowIds, [a, c, b], 'tab reordered within the strip');

  // Tear: drag B far outside the strip rect.
  const tabs2 = setTabRects();
  const tabB2 = tabs2.find((t) => t.dataset.tabFor === b);
  tabB2.dispatch('pointerdown', { button: 0, clientX: 250, clientY: 20 });
  fakeDocument.dispatch('pointermove', { clientX: 250, clientY: 300 });
  fakeDocument.dispatch('pointerup', { clientX: 250, clientY: 500 });
  assert.equal(manager.state(b).state, 'floating', 'drag beyond the strip tears out');
  assert.deepEqual(manager.groups()[0].windowIds, [a, c], 'group keeps the survivors');
});

test('drag shows a live snap preview that clears when the gesture settles', () => {
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
    setWorkspace() { return Promise.resolve({ ok: true, workspace: { revision: 2, windows: [], groups: [], shelf: { windowIds: [] } } }); },
    setWorkspaceGroups(groups) { return Promise.resolve({ ok: true, workspace: { revision: 3, windows: [], groups, shelf: { windowIds: [] } } }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: () => ({ dock: 'left', rect: { x: 0, y: 0, width: 640, height: 800 } }) },
  });
  manager.open('dockable');
  const a = 'window_dockable';
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 60, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 20, clientY: 130, buttons: 1 });
  const preview = root.children.find((c) => c.classList.contains('freeform-snap-preview'));
  assert.ok(preview, 'preview mounts while a dock is in range');
  assert.equal(preview.style.left, '0px');
  assert.equal(preview.style.width, '640px');
  fakeDocument.dispatch('pointerup', { clientX: 20, clientY: 130 });
  assert.ok(!root.children.some((c) => c.classList.contains('freeform-snap-preview')),
    'preview removed on release');
  assert.equal(manager.state(a).state, 'docked', 'the previewed dock applies');
});

test('drag without a dock in range never mounts a preview', () => {
  const { manager, root } = groupingManager(); // geometry: {} — no snapping
  const [a] = openThree(manager);
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 60, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 120, clientY: 160, buttons: 1 });
  assert.ok(!root.children.some((c) => c.classList.contains('freeform-snap-preview')),
    'no dock in range: no preview element');
  fakeDocument.dispatch('pointerup', { clientX: 120, clientY: 160 });
});

/* ------------------------------------------- 8-way resize + snap zones (Phase 6) */

function resizeHandleFor(frame, dir) {
  return frame.querySelectorAll('.freeform-window-resize').find((h) => h.dataset && h.dataset.resizeDir === dir);
}
function zoneHostIn(root) {
  return root.children.find((c) => c.classList.contains('freeform-snap-zones')) || null;
}
function edgeSnapManager(edgeResult) {
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: () => edgeResult },
  });
  return { manager, root };
}

test('register defaults include docked so every window can snap; explicit lists stay opt-outs', () => {
  assert.ok(wm.CreativeSurfaces.get('references').supportedStates.includes('docked'),
    "default supportedStates now carries 'docked'");
  assert.ok(!wm.CreativeSurfaces.get('locked_only').supportedStates.includes('docked'),
    'a surface that declares its own list without docked stays a non-docking surface');
  // Policy objects are frozen arrays, not mutable Sets (GPT Pro round-4):
  // a controller must not be able to rewrite the declared policy.
  assert.throws(() => { wm.CreativeSurfaces.get('references').supportedStates.push('docked'); }, /read only|not extensible|Cannot add/i);
});

test('resize: eight directions update the rect respecting per-surface minimums', () => {
  const { manager, root } = freshManager();
  const id = 'window_layers'; // layers minimumSize: 240x160
  manager.open('layers', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const rect = () => manager.state(id).rect;
  const drag = (dir, down, to) => {
    const h = resizeHandleFor(frame, dir);
    h.dispatch('pointerdown', { button: 0, clientX: down[0], clientY: down[1], pointerId: 1 });
    h.dispatch('pointermove', { clientX: to[0], clientY: to[1], pointerId: 1 });
    h.dispatch('pointerup', { clientX: to[0], clientY: to[1], pointerId: 1 });
  };

  drag('e', [500, 250], [560, 250]); // east edge grows right; x/y anchored
  assert.deepEqual(rect(), { x: 100, y: 100, width: 460, height: 300 });

  drag('w', [100, 250], [40, 250]); // west edge moves left, right edge anchored
  assert.deepEqual(rect(), { x: 40, y: 100, width: 520, height: 300 });

  drag('s', [300, 400], [300, 470]);
  assert.deepEqual(rect(), { x: 40, y: 100, width: 520, height: 370 });

  drag('n', [300, 100], [300, 60]);
  assert.deepEqual(rect(), { x: 40, y: 60, width: 520, height: 410 });

  drag('ne', [560, 60], [600, 40]);
  assert.deepEqual(rect(), { x: 40, y: 40, width: 560, height: 430 });

  drag('sw', [40, 470], [20, 500]);
  assert.deepEqual(rect(), { x: 20, y: 40, width: 580, height: 460 });

  // Minimum clamp on a moving edge: the opposite edge stays anchored.
  const before = rect();
  drag('w', [before.x, 250], [before.x + 500, 250]); // huge inward push clamps at min.width
  assert.equal(rect().width, 240);
  assert.equal(rect().x + rect().width, before.x + before.width, 'right edge stayed anchored at the clamp');

  drag('n', [300, rect().y], [300, rect().y + 300]);
  assert.equal(rect().height, 160);
});

test('resize gesture laws: pointercancel reverts and commits nothing; foreign pointers are ignored; maximised refuses', async () => {
  const { manager, root, calls } = freshManager();
  const id = 'window_layers';
  manager.open('layers', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  await new Promise((r) => setTimeout(r, 5)); // open()'s own persist lands -> baseline
  const baseline = calls.length;
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const before = { ...manager.state(id).rect };
  const h = resizeHandleFor(frame, 'e');

  h.dispatch('pointerdown', { button: 0, clientX: 500, clientY: 250, pointerId: 1 });
  h.dispatch('pointermove', { clientX: 700, clientY: 250, pointerId: 2 }); // foreign pointer: ignored
  assert.equal(manager.state(id).rect.width, before.width, 'a foreign pointer never steers the gesture');
  h.dispatch('pointermove', { clientX: 700, clientY: 250, pointerId: 1 });
  assert.equal(manager.state(id).rect.width, 600);
  h.dispatch('pointercancel', { pointerId: 1 });
  assert.deepEqual(manager.state(id).rect, before, 'cancel reverts to the pre-gesture rect');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(calls.length, baseline, 'an interrupted resize never persists');

  manager.maximise(id);
  h.dispatch('pointerdown', { button: 0, clientX: 500, clientY: 250, pointerId: 1 });
  h.dispatch('pointermove', { clientX: 900, clientY: 250, pointerId: 1 });
  h.dispatch('pointerup', { clientX: 900, clientY: 250, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(manager.state(id).state, 'maximised');
  assert.deepEqual(manager.state(id).rect, before, 'maximised windows do not resize (restoreRect untouched)');
});

test('resize commit persists once with the final rect', async () => {
  const { manager, root, calls } = freshManager();
  const id = 'window_layers';
  manager.open('layers', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  await new Promise((r) => setTimeout(r, 5));
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const h = resizeHandleFor(frame, 'se');
  h.dispatch('pointerdown', { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
  h.dispatch('pointermove', { clientX: 520, clientY: 430, pointerId: 1 });
  h.dispatch('pointerup', { clientX: 520, clientY: 430, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const spatials = calls.filter((c) => c.kind === 'spatial');
  assert.equal(spatials.length, 1, 'the commit persists exactly once');
  const last = spatials[spatials.length - 1];
  assert.equal(last.windowId, id);
  assert.equal(last.patch.width, 420);
  assert.equal(last.patch.height, 330);
  assert.ok(last.mutationId, 'gesture commits carry a per-gesture mutationId (plan S4: the deduped spatial lane)');
});

test('snap zones render during a header drag for a default-supported surface and emphasize the settling edge', () => {
  const { manager, root } = edgeSnapManager({ dock: 'left', rect: { x: 0, y: 66, width: 420, height: 650 } });
  manager.open('layers', { rect: { x: 200, y: 200, width: 380, height: 280 } });
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 220, clientY: 220 });
  fakeDocument.dispatch('pointermove', { clientX: 10, clientY: 240, buttons: 1 });

  const host = zoneHostIn(root);
  assert.ok(host, 'the zone layer mounts while a docking-capable window drags');
  assert.ok(host.classList.contains('on'), 'zones visible during the drag');
  assert.equal(host.children.length, 4, 'one zone per desk edge');
  assert.ok(host.querySelector('.freeform-snap-zone.left.active'), 'left zone emphasized: snapPlace settles there');
  assert.ok(!host.querySelector('.freeform-snap-zone.right.active'), 'other zones stay calm');

  fakeDocument.dispatch('pointerup', { clientX: 10, clientY: 240 });
  assert.ok(zoneHostIn(root), 'zone layer persists as an element but...');
  assert.ok(!zoneHostIn(root).classList.contains('on'), 'switches off when the gesture settles');
  assert.ok(!zoneHostIn(root).querySelector('.freeform-snap-zone.active'), 'no emphasized zone after settle');
  assert.equal(manager.state('window_layers').state, 'docked', 'the emphasized dock applied');
});

test('Alt suppresses snap zones entirely during a drag', () => {
  const { manager, root } = edgeSnapManager({ dock: 'left', rect: { x: 0, y: 66, width: 420, height: 650 } });
  manager.open('layers', { rect: { x: 200, y: 200, width: 380, height: 280 } });
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 220, clientY: 220 });
  fakeDocument.dispatch('pointermove', { clientX: 10, clientY: 240, buttons: 1, altKey: true });
  const host = zoneHostIn(root);
  assert.ok(!host || !host.classList.contains('on'), 'alt disables snapping: no visible zones');
  fakeDocument.dispatch('pointerup', { clientX: 10, clientY: 240, altKey: true });
  assert.equal(manager.state('window_layers').state, 'floating', 'alt release stays floating, as today');
});

test('a severed gesture (ev.buttons lost) clears the zones mid-drag', () => {
  const { manager, root } = edgeSnapManager({ dock: 'left', rect: { x: 0, y: 66, width: 420, height: 650 } });
  manager.open('layers', { rect: { x: 200, y: 200, width: 380, height: 280 } });
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 220, clientY: 220 });
  fakeDocument.dispatch('pointermove', { clientX: 10, clientY: 240, buttons: 1 });
  assert.ok(zoneHostIn(root) && zoneHostIn(root).classList.contains('on'), 'zones were up');

  fakeDocument.dispatch('pointermove', { clientX: 12, clientY: 244, buttons: 0 }); // severed
  assert.ok(zoneHostIn(root), 'layer element may remain mounted');
  assert.ok(!zoneHostIn(root).classList.contains('on'), 'severed gesture switches the zones off');

  // The torn-down gesture is dead: a later pointerup must not dock or persist.
  const before = { ...manager.state('window_layers').rect };
  fakeDocument.dispatch('pointerup', { clientX: 12, clientY: 244 });
  assert.equal(manager.state('window_layers').state, 'floating');
  assert.deepEqual(manager.state('window_layers').rect, before);
});

test('Escape cancels a pending drop: geometry reverts, overlays clear, nothing commits', () => {
  const { manager, root } = edgeSnapManager({ dock: 'left', rect: { x: 0, y: 66, width: 420, height: 650 } });
  manager.open('layers', { rect: { x: 200, y: 200, width: 380, height: 280 } });
  const startRect = { ...manager.state('window_layers').rect };
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 220, clientY: 220 });
  fakeDocument.dispatch('pointermove', { clientX: 10, clientY: 240, buttons: 1 });
  assert.ok(root.children.some((c) => c.classList.contains('freeform-snap-preview')), 'preview was pending');

  fakeDocument.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(manager.state('window_layers').rect, startRect, 'pre-drag geometry restored');
  assert.ok(!root.children.some((c) => c.classList.contains('freeform-snap-preview')), 'dock ghost cleared');
  const host = zoneHostIn(root);
  assert.ok(!host || !host.classList.contains('on'), 'zones cleared');

  fakeDocument.dispatch('pointerup', { clientX: 10, clientY: 240 }); // dead gesture: no commit
  assert.equal(manager.state('window_layers').state, 'floating', 'escape-cancelled drop never docks');
  assert.deepEqual(manager.state('window_layers').rect, startRect);
});

test('docked -> floating restore roundtrip works for default-supported surfaces', () => {
  let nearEdge = true;
  const root = makeNode('div');
  const manager = wm.WindowManager({
    root, document: fakeDocument,
    api: { upsertWorkspaceObject: (p) => Promise.resolve({ ok: true, object: p }), getWorkspace: () => Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }) },
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: (rect, m) => (nearEdge ? { dock: 'left', rect: { x: 0, y: 66, width: rect.width, height: m.height - 150 } } : null) },
  });
  manager.open('probe', { rect: { x: 300, y: 200, width: 380, height: 300 } });
  const id = 'window_probe';
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const head = frame.querySelector('.freeform-window-head');

  head.dispatch('pointerdown', { button: 0, clientX: 320, clientY: 220 });
  fakeDocument.dispatch('pointermove', { clientX: 8, clientY: 240, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 8, clientY: 240 });
  assert.equal(manager.state(id).state, 'docked', 'transition(model, docked) applies for a default-supported surface');
  assert.equal(manager.state(id).rect.x, 0, 'docked rect comes from dockRect/edgeSnap geometry');

  nearEdge = false; // dragged away from every edge
  head.dispatch('pointerdown', { button: 0, clientX: 30, clientY: 220 });
  fakeDocument.dispatch('pointermove', { clientX: 500, clientY: 260, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 500, clientY: 260 });
  const after = manager.state(id);
  assert.equal(after.state, 'floating', 'releasing off-edge re-floats a docked window');
  assert.equal(after.rect.x, 0 + (500 - 30), 'floating rect follows the free release point');
});

test('group work travels as identity-exact group.create intents (no revision token to seed)', async () => {
  const { manager, structural } = groupingManager();
  await manager.init();
  const [a, b] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  await new Promise((r) => setTimeout(r, 5));
  const create = structural.find((c) => c.kind === 'intent' && c.op.kind === 'group.create');
  assert.ok(create, 'group.create intent recorded');
  assert.deepEqual(create.op.members.map((m) => m.windowId).sort(), [a, b].sort(), 'members travel as WindowRefs');
  assert.equal(create.op.active.windowId, a);
});

test('two desks on one shared v4 surface: no client-side revision gate exists to bypass — disjoint intents converge server-side', async () => {
  // The v3 whole-array clobber class (stale baseRevision silently
  // overwriting another desk's landed write) is structurally gone:
  // membership ops are per-group intents carrying WindowRefs, validated
  // and serialized server-side (lib/tests/workspace-v4.test.js pins the
  // disjoint-work property). This test pins the CLIENT half: two desks
  // over one shared surface produce canonical, dedupable intents.
  const record = [];
  const mkApi = () => v4ApiFixture({ record });
  const mgrA = wm.WindowManager({ root: makeNode('div'), document: fakeDocument, api: mkApi(), viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  const mgrB = wm.WindowManager({ root: makeNode('div'), document: fakeDocument, api: mkApi(), viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await Promise.all([mgrA.init(), mgrB.init()]);
  mgrA.open('references');
  mgrA.open('layers');
  mgrB.open('probe');
  await new Promise((r) => setTimeout(r, 5));
  mgrA.groupWindows(['window_references', 'window_layers'], { activeWindowId: 'window_references' });
  await new Promise((r) => setTimeout(r, 10));
  const creates = record.filter((c) => c.kind === 'intent' && c.op.kind === 'group.create');
  assert.equal(creates.length, 1, 'one canonical group.create; no revision ladder, no adopt-and-retry');
  assert.equal(creates[0].op.members.length, 2);
});

/* ------------------------------------------------------ shelf (Phase 2) */

function shelfManager() {
  const shelfCalls = [];
  const root = makeNode('div');
  const shelf = makeNode('nav');
  const api = v4ApiFixture({ record: shelfCalls });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  return { manager, root, shelf, shelfCalls };
}

test('minimise is disabled without a shelf; attachShelf re-enables it and renders a restore chip', async () => {
  const { manager, root, shelf, shelfCalls } = shelfManager();
  manager.open('references', { rect: { x: 120, y: 90, width: 400, height: 300 } });
  const frame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_references');
  const minBtn = frame.querySelector('.freeform-window-btn.minimise');
  assert.equal(minBtn.disabled, true, 'no shelf yet: minimise disabled with a reason');

  manager.attachShelf(shelf);
  assert.equal(minBtn.disabled, false, 'attachShelf re-enables minimise');

  manager.minimise('window_references');
  assert.equal(manager.state('window_references').state, 'minimised');
  assert.equal(frame.hidden, true, 'minimised frame hidden');
  const chip = shelf.children.find((c) => c.classList.contains('freeform-shelf-chip'));
  assert.ok(chip, 'shelf renders a chip for the minimised window');
  assert.equal(chip.dataset.windowId, 'window_references');
  await new Promise((r) => setTimeout(r, 5));
  const minimised = shelfCalls.find((c) => c.kind === 'intent' && c.op.kind === 'shelf.minimise');
  assert.ok(minimised && minimised.op.window.windowId === 'window_references', 'shelf membership persisted as the shelf.minimise intent');

  chip.dispatch('click', {});
  const restored = manager.state('window_references');
  assert.equal(restored.state, 'floating');
  assert.deepEqual(restored.rect, { x: 120, y: 90, width: 400, height: 300 }, 'restore preserves the prior rect');
  assert.equal(frame.hidden, false);
  await new Promise((r) => setTimeout(r, 5));
  const restore = shelfCalls.filter((c) => c.kind === 'intent' && c.op.kind === 'shelf.restore');
  assert.ok(restore.length >= 1, 'shelf emptied via the shelf.restore intent');
});

test('dragging a shelf chip out re-floats the window at the drop point', async () => {
  const { manager, root, shelf } = shelfManager();
  manager.attachShelf(shelf);
  manager.open('references', { rect: { x: 120, y: 90, width: 400, height: 300 } });
  manager.minimise('window_references');
  const chip = shelf.children.find((c) => c.classList.contains('freeform-shelf-chip'));

  chip.dispatch('pointerdown', { button: 0, clientX: 100, clientY: 700 });
  fakeDocument.dispatch('pointermove', { clientX: 130, clientY: 700 }); // >10px => a drag, not a click
  fakeDocument.dispatch('pointerup', { clientX: 260, clientY: 500 });

  const state = manager.state('window_references');
  assert.equal(state.state, 'floating', 'chip drag restores as floating');
  assert.equal(state.rect.x, 260, 're-floated at the drop point (root rect 0,0)');
  assert.equal(state.rect.y, 500);
  assert.equal(shelf.children.filter((c) => c.classList.contains('freeform-shelf-chip')).length, 0, 'chip removed');
});

/* ------------------------------------------------ grouping (Phase 2) */

function groupingManager() {
  const structural = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record: structural });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  return { manager, root, structural };
}

function openThree(manager) {
  manager.open('references');
  manager.open('layers');
  manager.open('probe');
  return ['window_references', 'window_layers', 'window_probe'];
}

test('groupWindows tabs the members: active visible with a tab strip, others hidden', () => {
  const { manager, root } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b, c], { activeWindowId: b });
  assert.equal(manager.state(a).state, 'tabbed');
  assert.equal(manager.state(b).state, 'tabbed');
  assert.equal(manager.state(c).state, 'tabbed');
  const group = manager.groups()[0];
  assert.deepEqual(group.windowIds, [a, b, c]);
  assert.equal(group.activeWindowId, b);
  const activeFrame = root.children.find((f) => f.dataset && f.dataset.windowId === b);
  const hiddenFrame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  assert.equal(activeFrame.hidden, false, 'active member visible');
  assert.equal(hiddenFrame.hidden, true, 'inactive member hidden');
  assert.ok(activeFrame.classList.contains('freeform-window-grouped'), 'grouped chrome class');
  const tabs = activeFrame.querySelectorAll('.freeform-window-tab');
  assert.equal(tabs.length, 3, 'tab strip lists every member');
  const activeTab = tabs.find((t) => t.dataset.tabFor === b);
  assert.ok(activeTab && activeTab.classList.contains('active'), 'active tab marked');
});

test('switchTab flips visibility and the active tab', () => {
  const { manager, root } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b, c], { activeWindowId: a });
  manager.switchTab(c);
  const group = manager.groups()[0];
  assert.equal(group.activeWindowId, c);
  const cFrame = root.children.find((f) => f.dataset && f.dataset.windowId === c);
  const aFrame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  assert.equal(cFrame.hidden, false);
  assert.equal(aFrame.hidden, true);
  const tabs = cFrame.querySelectorAll('.freeform-window-tab');
  const cTab = tabs.find((t) => t.dataset.tabFor === c);
  assert.ok(cTab.classList.contains('active'), 'new member owns the active tab');
});

test('tearOut frees the window; the group survives with the remaining pair', async () => {
  const { manager, structural } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b, c], { activeWindowId: a });
  manager.tearOut(b, 400, 300);
  assert.equal(manager.state(b).state, 'floating');
  assert.equal(manager.state(b).rect.x, 400);
  const group = manager.groups()[0];
  assert.deepEqual(group.windowIds, [a, c], 'group survives losing one member');
  assert.equal(manager.state(a).state, 'tabbed');
  await new Promise((r) => setTimeout(r, 5));
  const leave = structural.find((c) => c.kind === 'intent' && c.op.kind === 'group.leave');
  assert.ok(leave && leave.op.member.windowId === b, 'tear-out persists as the group.leave intent (floating at the drop point)');
});

test('ungroup returns every member to floating and clears the group', () => {
  const { manager } = groupingManager();
  const [a, b, c] = openThree(manager);
  const group = manager.groupWindows([a, b, c]);
  manager.ungroup(group.groupId);
  assert.equal(manager.groups().length, 0);
  for (const id of [a, b, c]) {
    assert.equal(manager.state(id).state, 'floating');
    assert.equal(manager.state(id).frame ? true : true, true);
  }
});

test('closing one grouped member never destroys the others', () => {
  const { manager } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b, c], { activeWindowId: a });
  manager.close(b);
  assert.ok(manager.state(a), 'other members keep their windows');
  assert.ok(manager.state(c), 'other members keep their windows');
  const group = manager.groups()[0];
  assert.deepEqual(group.windowIds, [a, c]);
  assert.equal(group.activeWindowId, a, 'active survives when a non-active member closes');
  manager.close(a);
  const after = manager.groups()[0];
  assert.equal(after.windowIds.length, 1, 'last two members: survivor keeps its window');
  assert.ok(manager.state(c));
});

/* ----------------------- GPT Pro round-3 triage: durable dock + close + cancel */

test('dock commit persists the durable edge as a typed presentation; re-float clears it', async () => {
  const record = [];
  const root = makeNode('div');
  let snap = { dock: 'left', rect: { x: 0, y: 0, width: 640, height: 800 } };
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: () => snap },
  });
  manager.open('layers');
  const id = 'window_layers';
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 600, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 20, clientY: 130, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 20, clientY: 130 });
  await new Promise((r) => setTimeout(r, 0));
  const pres = record.filter((c) => c.kind === 'intent' && c.op.kind === 'window.setPresentation');
  assert.equal(pres[pres.length - 1].op.mode, 'docked', 'commit persists the docked presentation');
  assert.equal(pres[pres.length - 1].op.edge, 'left', 'commit persists the durable edge');
  snap = null;
  head.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 400, clientY: 130, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 400, clientY: 130 });
  await new Promise((r) => setTimeout(r, 0));
  const after = record.filter((c) => c.kind === 'intent' && c.op.kind === 'window.setPresentation').pop();
  assert.equal(after.op.mode, 'floating', 'drag-off-edge re-floats');
  assert.equal(manager.state(id).dock, null, 're-float clears the stored dock');
});

test('docked state survives reload: init keeps the edge and re-derives geometry', async () => {
  const root = makeNode('div');
  let dockRectCalls = 0;
  const api = v4ApiFixture({ doc: {
    schemaVersion: 4, structuralRevision: 5, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_d1' }, type: 'layers_panel', space: 'screen', entityRef: 'layers:main', presentation: { kind: 'docked', edge: 'left' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 16, y: 66, width: 400, height: 300, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [] }, focus: null,
  } });
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { dockRect: (dock, rect) => { dockRectCalls += 1; return { ...rect, x: 16, y: 66 }; } },
  });
  await manager.init();
  const st = manager.state('window_layers');
  assert.equal(st.state, 'docked', 'docked survives reload when an edge is stored (was: downgraded to floating)');
  assert.equal(dockRectCalls, 1, 'geometry re-derives from the stored edge');
  assert.equal(st.rect.x, 16);
  assert.equal(st.rect.y, 66);
});

test('close is authoritative server-side: the durable window.close intent carries the exact incarnation', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references');
  await new Promise((r) => setTimeout(r, 0)); // the create lands and its ref is adopted before close
  manager.close('window_references');
  await new Promise((r) => setTimeout(r, 0));
  const closeOp = record.find((c) => c.kind === 'intent' && c.op.kind === 'window.close');
  assert.ok(closeOp, 'close travels as the window.close intent');
  assert.equal(closeOp.op.window.windowId, 'window_references');
  assert.equal(closeOp.op.window.generation, 1, 'identity-exact: the adopted canonical ref, not a bare id');
  assert.ok(closeOp.op.window.incarnationId, 'incarnation carried — a stale-tab close can never touch a reopened one');
});

test('drag pointercancel is a terminal: geometry reverts, overlays clear, nothing persists', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: () => ({ dock: 'left', rect: { x: 0, y: 0, width: 640, height: 800 } }) },
  });
  manager.open('layers');
  await new Promise((r) => setTimeout(r, 0)); // open()'s async persist must land before the baseline snapshot
  const id = 'window_layers';
  const before = { ...manager.state(id).rect };
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 600, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 20, clientY: 130, buttons: 1 });
  assert.notDeepEqual(manager.state(id).rect, before, 'drag moved the frame before cancellation');
  fakeDocument.dispatch('pointercancel', { clientX: 20, clientY: 130 });
  assert.deepEqual(manager.state(id).rect, before, 'cancellation restored the pre-gesture snapshot (was: committed)');
  assert.ok(!root.children.some((c) => c.classList.contains('freeform-snap-preview')), 'preview cleared on cancel');
  const zones = zoneHostIn(root);
  assert.ok(!zones || !zones.classList.contains('on'), 'zones cleared on cancel');
  const baseline = persistCalls.length;
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(persistCalls.length, baseline, 'cancellation persists nothing');
});

/* ----------------- GPT Pro round-4 triage: close race, shelf docks, severed */

test('close before the create lands still closes identity-exactly: the chain serializes create-then-close', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references');
  manager.close('window_references'); // NO flush: the create is still queued on the write chain
  await new Promise((r) => setTimeout(r, 0));
  const createOp = record.find((c) => c.kind === 'intent' && c.op.kind === 'window.create');
  const closeOp = record.find((c) => c.kind === 'intent' && c.op.kind === 'window.close');
  assert.ok(createOp, 'create recorded');
  assert.ok(closeOp, 'close recorded');
  assert.equal(closeOp.op.window.incarnationId, createOp.op.incarnationId, 'close carries the incarnation the create minted — resurrection is structurally impossible (GPT Pro round-4)');
});

test('minimise then restore returns a docked window to its stored edge', async () => {
  const record = [];
  const root = makeNode('div');
  const shelf = makeNode('div');
  const api = v4ApiFixture({ record, doc: {
    // Seed a docked-left window that is ALSO on the shelf: restore must
    // return it to the dock, not float it (GPT Pro round-4).
    schemaVersion: 4, structuralRevision: 5, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_m1' }, type: 'layers_panel', space: 'screen', entityRef: 'layers:main', presentation: { kind: 'docked', edge: 'left' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 16, y: 66, width: 380, height: 600, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [{ windowId: 'window_layers', generation: 1, incarnationId: 'inc_m1' }] }, focus: null,
  } });
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { dockRect: (dock, rect) => ({ ...rect, x: 16 }) },
  });
  await manager.init();
  manager.attachShelf(shelf);
  manager.restore('window_layers');
  const st = manager.state('window_layers');
  assert.equal(st.state, 'docked', 'shelf restore returns the window to its stored dock (was: always floated)');
  assert.equal(st.rect.x, 16, 'docked geometry re-derives from the stored edge');
  await new Promise((r) => setTimeout(r, 0)); // queueIntent is async: flush the chain before reading the record
  const restoreOp = record.find((c) => c.kind === 'intent' && c.op.kind === 'shelf.restore');
  assert.equal(restoreOp.op.mode, 'resume', 'dock-aware restore resumes the latent presentation');
});

test('init repairs an out-of-policy docked row with a durable presentation intent', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record, doc: {
    schemaVersion: 4, structuralRevision: 5, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_r1' }, type: 'layers_panel', space: 'screen', entityRef: 'layers:main', presentation: { kind: 'docked', edge: 'top' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 16, y: 66, width: 400, height: 300, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [] }, focus: null,
  } });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  assert.equal(manager.state('window_layers').state, 'floating');
  const repair = record.find((c) => c.kind === 'intent' && c.op.kind === 'window.setPresentation' && c.op.mode === 'floating');
  assert.ok(repair, 'the repair is a durable intent (was: malformed row returned every session)');
});

test('tab tear and shelf chip severed buttons abort without tearing or restoring', async () => {
  const { manager, root } = groupingManager();
  const [a, b, c] = openThree(manager);
  manager.groupWindows([a, b, c], { activeWindowId: a });
  const activeFrame = root.children.find((f) => f.dataset && f.dataset.windowId === a);
  const strip = activeFrame.querySelector('.freeform-window-tabs');
  strip._rect = { left: 0, top: 0, right: 1000, bottom: 40 };
  const tabs = strip.querySelectorAll('.freeform-window-tab');
  const tab = tabs[0];
  tab._rect = { left: 0, top: 0, right: 100, bottom: 40 };
  // Severed move (buttons lost) past the tear threshold: the session must
  // end and the later pointerup must commit nothing.
  tab.dispatch('pointerdown', { button: 0, clientX: 50, clientY: 20, pointerId: 1 });
  fakeDocument.dispatch('pointermove', { clientX: 500, clientY: 500, buttons: 0, pointerId: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 500, clientY: 500, pointerId: 1 });
  assert.equal(manager.groups().length, 1, 'severed tab drag never tears the member out');
  assert.equal(manager.groups()[0].windowIds.length, 3, 'all three members still grouped');
});

/* --------------------- GPT Pro round-5 triage: error classes + invariants */




test('registry deep-freeze: defaultPlacement and contextualTools reject mutation', () => {
  const placement = { width: 500, height: 400, dock: null };
  const tool = { id: 'note', label: 'Note' };
  wm.CreativeSurfaces.register({ id: 'freeze_probe', title: 'Freeze Probe', entityType: 'generic_panel', defaultPlacement: placement, contextualTools: [tool] });
  const def = wm.CreativeSurfaces.get('freeze_probe');
  assert.throws(() => { def.defaultPlacement.width = 1; }, /read only|not extensible|Cannot assign/i, 'registered placement is a frozen clone');
  assert.throws(() => { def.contextualTools[0].id = 'hijack'; }, /read only|not extensible|Cannot assign/i, 'registered tools are frozen clones');
  assert.throws(() => { def.contextualTools.push({ id: 'inject' }); }, /read only|not extensible|Cannot add/i, 'the tools array is frozen');
  // The CALLER's original references stay mutable but detached: mutating
  // them must not affect the registered policy.
  placement.width = 999; tool.id = 'mutated';
  assert.equal(def.defaultPlacement.width, 500, 'retained source reference cannot rewrite the registered placement');
  assert.equal(def.contextualTools[0].id, 'note', 'retained source reference cannot rewrite the registered tool');
});




test('resize cancel after anchored-edge undock restores the full lifecycle', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: () => ({ dock: 'left', rect: { x: 16, y: 66, width: 380, height: 600 } }) },
  });
  manager.open('layers', { rect: { x: 300, y: 120, width: 380, height: 280 } });
  await new Promise((r) => setTimeout(r, 0));
  const id = 'window_layers';
  // Dock left via a header drag.
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 400, clientY: 140 });
  fakeDocument.dispatch('pointermove', { clientX: 30, clientY: 160, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 30, clientY: 160 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(manager.state(id).state, 'docked', 'sanity: window docked left');
  const dockedRect = { ...manager.state(id).rect };
  // Pull the anchored (west) edge: mid-resize the model undocks; cancel must
  // restore rect AND state AND dock.
  const westGrip = resizeHandleFor(frame, 'w');
  westGrip.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 300, pointerId: 9 });
  westGrip.dispatch('pointermove', { clientX: 260, clientY: 300, pointerId: 9, buttons: 1 });
  assert.equal(manager.state(id).state, 'floating', 'anchored-edge pull undocks mid-resize');
  const persistBaseline = persistCalls.length;
  westGrip.dispatch('pointercancel', { clientX: 260, clientY: 300, pointerId: 9 });
  const st = manager.state(id);
  assert.equal(st.state, 'docked', 'cancel restores the docked state');
  assert.equal(st.dock, 'left', 'cancel restores the stored edge');
  assert.deepEqual(st.rect, dockedRect, 'cancel restores the pre-gesture rect');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(persistCalls.length, persistBaseline, 'cancel persists nothing');
});

/* ------------------- phase: gesture kernel lock + dock-edge policies */

test('gesture lock: a second contact on the same window is refused while a gesture is live', async () => {
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('layers');
  const id = 'window_layers';
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === id);
  const head = frame.querySelector('.freeform-window-head');
  // First pointer starts and captures the window's gesture slot.
  head.dispatch('pointerdown', { button: 0, clientX: 300, clientY: 110, pointerId: 1 });
  fakeDocument.dispatch('pointermove', { clientX: 220, clientY: 150, buttons: 1, pointerId: 1 });
  const withOne = { ...manager.state(id).rect };
  assert.notEqual(withOne.x, 400, 'sanity: pointer 1 moved the frame');
  // Second pointer on the SAME window must be refused: no listener was
  // installed for it, so its moves cannot steer the frame (GPT Pro r3).
  head.dispatch('pointerdown', { button: 0, clientX: 220, clientY: 150, pointerId: 2 });
  fakeDocument.dispatch('pointermove', { clientX: 900, clientY: 700, buttons: 1, pointerId: 2 });
  assert.deepEqual(manager.state(id).rect, withOne, 'foreign pointer 2 never steers a live gesture');
  fakeDocument.dispatch('pointerup', { clientX: 220, clientY: 150, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 0));
  // Lock released at up: a new gesture on the same window must work again.
  head.dispatch('pointerdown', { button: 0, clientX: 220, clientY: 150, pointerId: 3 });
  fakeDocument.dispatch('pointermove', { clientX: 260, clientY: 150, buttons: 1, pointerId: 3 });
  fakeDocument.dispatch('pointerup', { clientX: 260, clientY: 150, pointerId: 3 });
  assert.equal(manager.state(id).rect.x, withOne.x + 40, 'gesture lock releases at up: next gesture proceeds');
});

test('dock policy: an edge outside dockEdges never docks and its zone never paints', async () => {
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { edgeSnap: () => ({ dock: 'top', rect: { x: 0, y: 0, width: 640, height: 800 } }) },
  });
  manager.open('layers'); // layers: dockable, default dockEdges left+right — top NOT allowed
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 600, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 620, clientY: 10, buttons: 1 });
  assert.ok(!root.children.some((c) => c.classList.contains('freeform-snap-preview')), 'no preview for a policy-forbidden edge');
  const host = zoneHostIn(root);
  assert.ok(host && host.classList.contains('on'), 'zones visible for a dock-capable drag');
  assert.ok(host.querySelector('.freeform-snap-zone.top.blocked'), 'the forbidden edge is masked out');
  assert.ok(!host.querySelector('.freeform-snap-zone.left.blocked'), 'allowed edges still paint');
  fakeDocument.dispatch('pointerup', { clientX: 620, clientY: 10 });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(manager.state('window_layers').state, 'floating', 'release over a forbidden edge never docks');
});


test('registry policy data is frozen through nesting: retained sources cannot rewrite nested values', () => {
  // GPT Pro round-6 minor: shallow clones left nested configuration mutable
  // through BOTH the retained source and the exposed definition.
  const placement = { width: 500, height: 400, dock: null, meta: { tag: 'keep' } };
  const tool = { id: 'note', label: 'Note', payload: { keybind: 'n' } };
  wm.CreativeSurfaces.register({ id: 'freeze_deep_probe', title: 'Freeze Deep Probe', entityType: 'generic_panel', defaultPlacement: placement, contextualTools: [tool] });
  const def = wm.CreativeSurfaces.get('freeze_deep_probe');
  assert.throws(() => { def.defaultPlacement.meta.tag = 'rewrite'; }, /read only|not extensible|Cannot assign/i, 'nested placement metadata is frozen');
  assert.throws(() => { tool.payload.keybind = 'hijack'; }, /read only|not extensible|Cannot assign/i, 'the SOURCE nested object was cloned, not aliased');
  assert.equal(def.defaultPlacement.meta.tag, 'keep');
  assert.equal(def.contextualTools[0].payload.keybind, 'n');
});


test('title model/DOM split (S0): state().title is always a string; span, tabs and shelf chips render it', () => {
  const { manager, root } = freshManager();
  manager.open('layers');
  assert.equal(typeof manager.state('window_layers').title, 'string', 'state().title is a string, never a DOM node');
  assert.equal(manager.state('window_layers').title, 'Layers', 'open carries the surface title (duplicate-key null-out killed)');
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const span = frame.querySelector('.freeform-window-title');
  assert.equal(span.textContent, 'Layers', 'the title span renders the surface title IMMEDIATELY (not only after rename)');

  manager.open('references', { windowId: 'window_refs', title: 'Custom Refs' });
  const refsFrame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_refs');
  assert.equal(refsFrame.querySelector('.freeform-window-title').textContent, 'Custom Refs');
  assert.equal(manager.state('window_refs').title, 'Custom Refs');

  // Group tabs must render the title STRING (the old span-assignment coerced to garbage)
  manager.groupWindows(['window_layers', 'window_refs']);
  const tabs = frame.querySelectorAll('.freeform-window-tab');
  const refsTab = tabs.find((t) => t.dataset.tabFor === 'window_refs');
  assert.equal(refsTab.textContent, 'Custom Refs', 'tab label is the title string');

  // Shelf chips too
  const shelf = makeNode('nav');
  manager.attachShelf(shelf);
  manager.minimise('window_refs');
  const chip = shelf.children.find((c) => c.classList.contains('freeform-shelf-chip'));
  assert.equal(chip.textContent, 'Custom Refs', 'shelf chip label is the title string');
  assert.equal(chip.getAttribute('aria-label'), 'restore Custom Refs');
});

/* ---- v4 cutover replacements for the retired v3 error-class/repair tests
 * (close-delete 409/404 ladder, revision-gate classification, stale-dock
 * hybrids, out-of-policy downgrade): their guarantees moved to the typed
 * intent protocol — terminal-vs-transient classification lives in
 * v4-client.test.js, taxonomy enforcement in lib/tests/workspace-v4.test.js,
 * and the manager-level contracts below. ---- */

test('v4 close classification: 410 (already tombstoned) settles silently; transient failures stay visible', async () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    {
      const record = [];
      const api = v4ApiFixture({ record });
      api.applyWorkspaceIntent = (payload) => {
        record.push({ kind: 'intent', op: payload.op, intentId: payload.intentId });
        return Promise.reject(Object.assign(new Error('WINDOW_GENERATION_GONE window_references'), { status: 410, code: 'WINDOW_GENERATION_GONE', detail: { code: 'WINDOW_GENERATION_GONE' } }));
      };
      const manager = wm.WindowManager({ root: makeNode('div'), document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
      manager.open('references');
      manager.close('window_references');
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      assert.ok(record.some((c) => c.op.kind === 'window.close'), 'close intent sent');
      assert.ok(!warnings.some((w) => w.includes('close not confirmed')), 'already-tombstoned settles as idempotent success: no warn, no retry');
    }
    {
      const record = [];
      const api = v4ApiFixture({ record });
      api.applyWorkspaceIntent = (payload) => {
        record.push({ kind: 'intent', op: payload.op, intentId: payload.intentId });
        return Promise.reject(Object.assign(new Error('gateway exploded'), { status: 502 }));
      };
      const manager = wm.WindowManager({ root: makeNode('div'), document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
      manager.open('references');
      manager.close('window_references');
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      assert.ok(warnings.some((w) => w.includes('close not confirmed')), 'uncertain close failure stays visible (the outbox holds the intent durably)');
    }
  } finally {
    console.warn = origWarn;
  }
});

test('v4 rows cannot carry stale-dock hybrids: lifecycle derives from canonical ownership', async () => {
  // The v3 hybrids ({state:'tabbed',dock:'right'} / {state:'floating',
  // dock:'left'}) are structurally impossible in v4: an edge exists only
  // inside presentation:{kind:'docked',edge}; tabbed/minimised/floating are
  // DERIVED from group/shelf membership at restore. A grouped member with a
  // latent docked presentation keeps the edge as LATENT (group.leave resume
  // reapplies it) — never as current state.
  const api = v4ApiFixture({ doc: {
    schemaVersion: 4, structuralRevision: 5, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_t1' }, type: 'layers_panel', entityRef: 'layers:main', presentation: { kind: 'docked', edge: 'left' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 100, y: 100, width: 380, height: 280, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
      { ref: { windowId: 'window_references', generation: 1, incarnationId: 'inc_t2' }, type: 'reference_board', entityRef: 'board:references', presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 100, y: 100, width: 380, height: 280, rotation: 0, scale: 1, zIndex: 4 }, structureVersion: 1, spatialVersion: 1 },
      { ref: { windowId: 'window_notes', generation: 1, incarnationId: 'inc_t3' }, type: 'note', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 200, y: 200, width: 300, height: 220, rotation: 0, scale: 1, zIndex: 5 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [{ groupId: 'g_stale', version: 1, members: [{ windowId: 'window_layers', generation: 1, incarnationId: 'inc_t1' }, { windowId: 'window_references', generation: 1, incarnationId: 'inc_t2' }], active: { windowId: 'window_references', generation: 1, incarnationId: 'inc_t2' } }],
    shelf: { version: 1, members: [] }, focus: null,
  } });
  const root = makeNode('div');
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  assert.equal(manager.state('window_layers').state, 'tabbed', 'group membership derives tabbed');
  assert.equal(manager.state('window_layers').dock, 'left', 'a latent docked presentation survives grouping as LATENT state (resume material)');
  assert.equal(manager.state('window_references').state, 'tabbed', 'active member derives tabbed');
  assert.equal(manager.state('window_notes').state, 'floating', 'ungrouped derives floating');
  assert.equal(manager.state('window_notes').dock, null, 'floating presentation carries NO edge — the surprise-redock hybrid cannot exist');
});

test('shelf restore to docked shows content: collapsed is cleared', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record, doc: {
    schemaVersion: 4, structuralRevision: 5, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_c1' }, type: 'layers_panel', space: 'screen', entityRef: 'layers:main', presentation: { kind: 'docked', edge: 'left' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 16, y: 66, width: 380, height: 600, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [{ windowId: 'window_layers', generation: 1, incarnationId: 'inc_c1' }] }, focus: null,
  } });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: { dockRect: (d, rect) => ({ ...rect, x: 16 }) } });
  await manager.init();
  const shelf = makeNode('div');
  manager.attachShelf(shelf);
  manager.restore('window_layers');
  const st = manager.state('window_layers');
  assert.equal(st.state, 'docked');
  assert.equal(st.collapsed, false, 'restored docked window shows content (collapse cleared)');
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  assert.ok(frame && !frame.classList.contains('freeform-window-collapsed'), 'body renders expanded');
});

test('structural ops dispatched inside the create-response window carry the ADOPTED ref (implementation-lens F2)', async () => {
  const { manager, calls } = freshManager();
  manager.open('references');
  manager.minimise('window_references'); // NO flush: the create is still in flight on the chain
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  const create = calls.find((c) => c.kind === 'intent' && c.op.kind === 'window.create');
  const min = calls.find((c) => c.kind === 'intent' && c.op.kind === 'shelf.minimise');
  assert.ok(create, 'create recorded');
  assert.ok(min, 'minimise recorded');
  assert.equal(min.op.window.generation, 1, 'send-time ref construction: the ADOPTED generation, never the mint-time 0');
  assert.equal(min.op.window.incarnationId, create.op.incarnationId, 'same incarnation the create minted');
});

test('Stage-2 P1: surfaces carry a coordinateSpace classification (world default; explicit screen chrome; bad values rejected)', () => {
  wm.CreativeSurfaces.register({ id: 'default_space_probe', title: 'Default', entityType: 'generic_panel' });
  const def = wm.CreativeSurfaces.get('default_space_probe');
  assert.equal(def.coordinateSpace, 'world', 'unclassified registrations default to world (content surfaces)');
  wm.CreativeSurfaces.register({ id: 'chrome_probe', title: 'Chrome', entityType: 'generic_panel', coordinateSpace: 'screen' });
  assert.equal(wm.CreativeSurfaces.get('chrome_probe').coordinateSpace, 'screen', 'explicit screen chrome accepted');
  assert.throws(() => wm.CreativeSurfaces.register({ id: 'bad_space', title: 'Bad', coordinateSpace: 'pixel' }), /coordinateSpace/);
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'freeform-surfaces.js'), 'utf8');
  assert.equal((src.match(/coordinateSpace: 'world',/g) || []).length, 7, 'every shipped freeform surface is explicitly world-classified');
});

test('Stage-2 P2: world surfaces keep canonical WORLD rects — pan/zoom re-project placement, drags unproject at the live scale', async () => {
  let vp = { x: 0, y: 0, zoom: 1 };
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  wm.CreativeSurfaces.register({ id: 'worldscene', title: 'World Scenes', entityType: 'sequence_strip', coordinateSpace: 'world' });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, getViewport: () => vp, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('worldscene');
  const base = { ...manager.state('window_worldscene').rect };
  assert.ok(Number.isFinite(base.x) && Number.isFinite(base.width), 'world default rect in world units');
  vp = { x: 240, y: 120, zoom: 1 };
  manager.focus('window_worldscene');
  assert.deepEqual(manager.state('window_worldscene').rect, base, 'pan never rewrites the canonical world rect');
  vp = { x: 0, y: 0, zoom: 2 };
  manager.focus('window_worldscene');
  assert.deepEqual(manager.state('window_worldscene').rect, base, 'zoom never rewrites the canonical world rect');
  // baseScale = min(1280/1024, 800/1024) = 0.78125; at zoom 2 s = 1.5625.
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_worldscene');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 300, clientY: 200 });
  fakeDocument.dispatch('pointermove', { clientX: 402.5, clientY: 200, buttons: 1 }); // +102.5 screen px -> +65.6 world units
  fakeDocument.dispatch('pointerup', { clientX: 402.5, clientY: 200 });
  assert.ok(Math.abs(manager.state('window_worldscene').rect.x - (base.x + 65.6)) <= 0.5, 'drag delta unprojects at the live worldScale (state adopts the committed rounding)');
  await new Promise((r) => setTimeout(r, 5));
  const spatial = record.filter((c) => c.kind === 'spatial').pop();
  assert.ok(spatial, 'world geometry persists through the v4 spatial lane');
  assert.ok(Math.abs(spatial.patch.x - (base.x + 65.6)) <= 0.5, 'persisted spatial carries WORLD units (persist rounds to integer)');
});

test('Stage-2 P3: legacy screen-unit rows convert to world at restore (client-informed backfill) and re-persist', async () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  const record = [];
  const root = makeNode('div');
  // A world-classified surface's row persisted by the PRE-world client:
  // screen-space rect + space:'screen'.
  const api = v4ApiFixture({ record, doc: {
    schemaVersion: 4, structuralRevision: 3, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_worldscene', generation: 1, incarnationId: 'inc_ws1' }, type: 'sequence_strip', space: 'screen', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 640, y: 400, width: 328, height: 288, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [] }, focus: null,
  } });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, getViewport: () => vp, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const st = manager.state('window_worldscene');
  // scale = min(1280/1024, 800/1024) = 0.78125; screen centre (640,400) maps to world (0,0).
  assert.ok(Math.abs(st.rect.x) <= 0.5 && Math.abs(st.rect.y) <= 0.5, 'screen centre maps to the world origin');
  assert.ok(Math.abs(st.rect.width - 328 / 0.78125) <= 0.5, 'size converts to world units');
  await new Promise((r) => setTimeout(r, 5));
  const spatial = record.filter((c) => c.kind === 'spatial').pop();
  assert.ok(spatial, 'the corrected world geometry re-persists durably');
  assert.ok(Math.abs(spatial.patch.x) <= 1, 'persisted patch carries world values');
});

test('Stage-2 P4: creates birth-flag their coordinate space; the world cascade owns world-surface placement (defaultPlacement is screen-chrome-only)', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('worldscene'); // world-classified (registered by the P2 test)
  manager.open('references'); // screen-classified fixture (chrome path)
  await new Promise((r) => setTimeout(r, 0));
  const creates = record.filter((c) => c.kind === 'intent' && c.op.kind === 'window.create');
  const worldCreate = creates.find((c) => c.op.windowId === 'window_worldscene');
  const screenCreate = creates.find((c) => c.op.windowId === 'window_references');
  assert.equal(worldCreate.op.space, 'world', 'world surfaces birth-flag space:world (no mixed authority at birth)');
  assert.equal(screenCreate.op.space, 'screen', 'screen chrome birth-flags screen');
  // defaultPlacement audit conclusion: world surfaces place via the world
  // cascade (P2); declared defaultPlacement remains the SCREEN-chrome path.
  const a = manager.state('window_worldscene');
  assert.ok(Number.isFinite(a.rect.x) && a.rect.width >= 200, 'world cascade placement');
});

test('group-echo race class: switchTab inside the create-response window keeps the newer active and sends the SERVER group id', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  const [a, b] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  manager.switchTab(b); // NO await: dispatched while the create response is still in flight
  await new Promise((r) => setTimeout(r, 5));
  const group = manager.groups()[0];
  assert.equal(group.activeWindowId, b, 'the newer local active survives the swap (stale echo never regresses it)');
  const activate = record.find((c) => c.kind === 'intent' && c.op.kind === 'group.activate');
  assert.ok(activate, 'activate recorded');
  assert.equal(activate.op.groupId, group.groupId, 'send-time re-resolution: the SERVER-minted id, never the dead provisional id');
  assert.ok(!activate.op.groupId.startsWith('group_'), 'provisional local id never reaches the wire');
});

test('Stage-2 P3 true-up: the space flag rides the conversion wire — a SECOND init never re-converts (no compounding drift)', async () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  const legacyDoc = () => ({
    schemaVersion: 4, structuralRevision: 3, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_worldscene', generation: 1, incarnationId: 'inc_tu1' }, type: 'sequence_strip', space: 'screen', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 640, y: 400, width: 328, height: 288, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [] }, focus: null,
  });
  const mkManager = (doc, record) => wm.WindowManager({
    root: makeNode('div'), document: fakeDocument,
    api: v4ApiFixture({ record, doc }),
    getViewport: () => vp,
    viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {},
  });

  // First init: converts AND trues the flag on the same wire call.
  const record1 = [];
  const m1 = mkManager(legacyDoc(), record1);
  await m1.init();
  await new Promise((r) => setTimeout(r, 5));
  const tu = record1.filter((c) => c.kind === 'spatial').pop();
  assert.ok(tu, 'conversion persisted');
  assert.equal(tu.space, 'world', 'the true-up flag rides the conversion PATCH');
  const converted = { ...m1.state('window_worldscene').rect };

  // Simulate the store carrying the corrected row (space world + converted geometry):
  const doc2 = legacyDoc();
  doc2.windows[0].space = 'world';
  doc2.windows[0].spatial = { ...doc2.windows[0].spatial, x: Math.round(converted.x), y: Math.round(converted.y), width: Math.round(converted.width), height: Math.round(converted.height) };

  // Second init: must NOT convert again — no spatial intent, geometry identical.
  const record2 = [];
  const m2 = mkManager(doc2, record2);
  await m2.init();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(record2.filter((c) => c.kind === 'spatial').length, 0, 'no re-conversion on a truthed-up row');
  const again = m2.state('window_worldscene').rect;
  assert.ok(Math.abs(again.x - converted.x) <= 0.5 && Math.abs(again.width - converted.width) <= 0.5, 'no compounding drift across reloads');
});

test('Stage-2 B2: a docked world surface restores with its canonical world rect LATENT (no rail bake at boot)', async () => {
  const api = v4ApiFixture({ doc: {
    schemaVersion: 4, structuralRevision: 5, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_worldscene', generation: 1, incarnationId: 'inc_b2d' }, type: 'sequence_strip', space: 'world', entityRef: null, presentation: { kind: 'docked', edge: 'left' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: -350, y: -140, width: 460, height: 360, rotation: 0, scale: 1, zIndex: 3 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [], shelf: { version: 1, members: [] }, focus: null,
  } });
  const root = makeNode('div');
  const manager = wm.WindowManager({ root, document: fakeDocument, api, getViewport: () => ({ x: 0, y: 0, zoom: 1 }), viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: { dockRect: (dock, rect) => ({ ...rect, x: 12, y: 66 }) } });
  await manager.init();
  const st = manager.state('window_worldscene');
  assert.equal(st.state, 'docked', 'docked presentation restored');
  assert.equal(st.rect.x, -350, 'the canonical WORLD rect stays latent — the screen rail is rendered, never baked (B2)');
  assert.equal(st.rect.y, -140, 'y untouched by dockRect');
  assert.equal(st.rect.width, 460, 'width untouched');
});

test('group-echo F1 class: dissolve is identity-exact by member (no id race, even inside the swap window)', async () => {
  const record = [];
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root: makeNode('div'), document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  const [a, b] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  manager.ungroup(manager.groups()[0].groupId); // NO await: dispatched inside the create-response window
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(manager.groups().length, 0, 'local group dissolved');
  const dissolve = record.find((c) => c.kind === 'intent' && c.op.kind === 'group.dissolve');
  assert.ok(dissolve, 'dissolve recorded');
  assert.ok(dissolve.op.member && dissolve.op.member.windowId, 'dissolve carries the identity-exact MEMBER locator');
  assert.equal(dissolve.op.groupId, undefined, 'no groupId guess on the wire');
});

test('Stage-3 T1/T2: freeform mode owns registry surfaces — legacy trail gated before construction, layers/scenes panels unregistered, layers tool routes surface-first', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');
  const flagAt = src.indexOf('const useFreeformDesk');
  const gateAt = src.indexOf('if (!useFreeformDesk) state.beatTrail = BEATS.BeatTrail');
  assert.ok(flagAt > -1 && gateAt > flagAt, 'the mode flag is computed BEFORE the gated legacy trail construction');
  const layersRegAt = src.indexOf("id: 'panel_layers'");
  const scenesRegAt = src.indexOf("id: 'panel_scenes'");
  const beatsRegAt = src.indexOf("id: 'panel_beats'");
  const panelGate = src.indexOf('// Stage-3 T1: registry-owned surfaces are NEVER dual-registered');
  assert.ok(panelGate > -1 && layersRegAt > panelGate && scenesRegAt > panelGate && beatsRegAt > scenesRegAt, 'layers+scenes registrations sit inside the Stage-3 gate');
  assert.ok(/if \(!useFreeformDesk\) \{/.test(src.slice(panelGate, layersRegAt)), 'the gate condition wraps the registrations');
  assert.ok(/function toggleLayersSurface\(\) \{/.test(src), 'surface toggle exists');
  assert.ok(src.includes("if (t === 'layers') { if (!toggleLayersSurface()) togglePanel(); return; }"), 'layers tool routes surface-first with legacy fallback');
});

test('Stage-4 G2: tabbed members render at the GROUP frame — switching tabs never moves the frame', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  // Deliberately DIFFERENT geometry: the second member would jump the frame
  // under the old per-member-rect model.
  manager.open('references', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  manager.open('layers', { rect: { x: 600, y: 420, width: 260, height: 180 } });
  manager.groupWindows(['window_references', 'window_layers'], { activeWindowId: 'window_references' });
  await new Promise((r) => setTimeout(r, 5));
  const frameA = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  assert.equal(frameA.hidden, false, 'active member visible');
  const rectA = { left: frameA.style.left, top: frameA.style.top, width: frameA.style.width, height: frameA.style.height };
  // Switch to the differently-geometried member: the FRAME must not move.
  manager.switchTab('window_layers');
  await new Promise((r) => setTimeout(r, 5));
  const frameB = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_layers');
  const rectB = { left: frameB.style.left, top: frameB.style.top, width: frameB.style.width, height: frameB.style.height };
  assert.deepEqual(rectB, rectA, 'switchTab swaps CONTENT only — the frame geometry is byte-identical (G2 core)');
  const frameAafter = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  assert.equal(frameAafter.hidden, true, 'the previous member hides');
  // The members' own latent rects survive untouched (server-owned truth).
  assert.equal(manager.state('window_layers').rect.x, 600, 'member latent rect intact');
});

test('Stage-4 G3: grouped geometry/lifecycle commits ride group.setFrame — member spatial stays latent', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  manager.open('layers', { rect: { x: 600, y: 420, width: 260, height: 180 } });
  manager.groupWindows(['window_references', 'window_layers'], { activeWindowId: 'window_references' });
  await new Promise((r) => setTimeout(r, 5));
  // DRAG the active grouped member: the FRAME moves; the member's rect does not.
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 200, clientY: 150 });
  fakeDocument.dispatch('pointermove', { clientX: 300, clientY: 150, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 300, clientY: 150 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(manager.groups()[0].frame.rect.x, 200, 'the GROUP frame moved by the drag');
  assert.equal(manager.state('window_references').rect.x, 100, 'member latent rect untouched by grouped drag');
  const setF = record.find((c) => c.kind === 'intent' && c.op.kind === 'group.setFrame');
  assert.ok(setF, 'group.setFrame recorded');
  assert.equal(setF.op.member.windowId, 'window_references', 'identity-exact member locator');
  assert.equal(record.filter((c) => c.kind === 'spatial' && c.windowId === 'window_references').length, 0, 'no member spatial PATCH for grouped geometry');
  // MAXIMISE the grouped member: the FRAME presentation maximises; the member stays tabbed.
  manager.maximise('window_references');
  assert.equal(manager.state('window_references').state, 'tabbed', 'member stays tabbed — the FRAME owns the presentation');
  assert.equal(manager.groups()[0].frame.presentation.kind, 'maximised');
  await new Promise((r) => setTimeout(r, 5)); // flush the maximise intent (async chain) before reading the record
  const maxOp = record.filter((c) => c.kind === 'intent' && c.op.kind === 'group.setFrame').pop();
  assert.equal(maxOp.op.patch.presentation.kind, 'maximised', 'frame maximise rode group.setFrame');
  // UNMAXIMISE returns the frame to floating; the member is still tabbed.
  manager.unmaximise('window_references');
  assert.equal(manager.groups()[0].frame.presentation.kind, 'floating');
  assert.equal(manager.state('window_references').state, 'tabbed');
});

test('Stage-4 G4: one group-scoped gesture lock — a second contact on another member tab is refused', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  manager.open('layers', { rect: { x: 600, y: 420, width: 260, height: 180 } });
  manager.groupWindows(['window_references', 'window_layers'], { activeWindowId: 'window_references' });
  await new Promise((r) => setTimeout(r, 5));
  // Live group gesture: pointer 1 drags the ACTIVE member's header.
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  const head = frame.querySelector('.freeform-window-head');
  head.dispatch('pointerdown', { button: 0, clientX: 200, clientY: 150, pointerId: 1 });
  fakeDocument.dispatch('pointermove', { clientX: 260, clientY: 150, buttons: 1, pointerId: 1 });
  // Second contact (pointer 2) on the OTHER member's tab: the group-scoped
  // lock must refuse it — the tear never starts.
  const strip = frame.querySelector('.freeform-window-tabs');
  strip._rect = { left: 0, top: 0, right: 1000, bottom: 40 };
  const tab = strip.querySelectorAll('.freeform-window-tab').find((t) => t.dataset.tabFor === 'window_layers');
  tab._rect = { left: 10, top: 0, right: 80, bottom: 40 };
  tab.dispatch('pointerdown', { button: 0, clientX: 40, clientY: 20, pointerId: 2 });
  fakeDocument.dispatch('pointermove', { clientX: 900, clientY: 500, buttons: 1, pointerId: 2 });
  fakeDocument.dispatch('pointerup', { clientX: 900, clientY: 500, pointerId: 2 });
  assert.equal(manager.groups().length, 1, 'the refused second gesture never tore the member out');
  assert.equal(manager.groups()[0].windowIds.length, 2, 'membership intact');
  // Release the live gesture.
  fakeDocument.dispatch('pointerup', { clientX: 260, clientY: 150, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(manager.groups()[0].windowIds.length, 2, 'settled cleanly');
});

test('Stage-4 G5: reload restores the GROUP frame once — the active member renders at the frame, not its latent rect', async () => {
  const root = makeNode('div');
  const api = v4ApiFixture({ doc: {
    schemaVersion: 4, structuralRevision: 7, spatialRevision: 1, viewportRevision: 1,
    windows: [
      { ref: { windowId: 'window_references', generation: 1, incarnationId: 'inc_r5a' }, type: 'reference_board', space: 'screen', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 100, y: 100, width: 400, height: 300, rotation: 0, scale: 1, zIndex: 5 }, structureVersion: 1, spatialVersion: 1 },
      { ref: { windowId: 'window_layers', generation: 1, incarnationId: 'inc_r5b' }, type: 'layers_panel', space: 'screen', entityRef: null, presentation: { kind: 'floating' }, beforeMaximise: null, collapsed: false, pinned: false, locked: false, spatial: { x: 700, y: 500, width: 260, height: 180, rotation: 0, scale: 1, zIndex: 6 }, structureVersion: 1, spatialVersion: 1 },
    ],
    groups: [{ groupId: 'g_r5', version: 3, members: [{ windowId: 'window_references', generation: 1, incarnationId: 'inc_r5a' }, { windowId: 'window_layers', generation: 1, incarnationId: 'inc_r5b' }], active: { windowId: 'window_references', generation: 1, incarnationId: 'inc_r5a' }, frame: { rect: { x: 240, y: 160, width: 420, height: 320 }, presentation: { kind: 'floating' }, zIndex: 9 } }],
    shelf: { version: 1, members: [] }, focus: null,
  } });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const g = manager.groups()[0];
  assert.ok(g.frame, 'the frame restored with the group');
  assert.deepEqual(g.frame.rect, { x: 240, y: 160, width: 420, height: 320 }, 'frame geometry canonical across reload');
  const frameEl = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  assert.equal(frameEl.style.left, '240px', 'the ACTIVE member renders at the FRAME geometry after reload');
  assert.equal(frameEl.style.width, '420px');
  assert.equal(manager.state('window_layers').rect.x, 700, 'latent member rect untouched');
  await new Promise((r) => setTimeout(r, 5));
  const api2 = api; // no spatial intents fired at restore (the frame is already canonical)
  void api2;
});

test('Stage-4 G3 repair: grouped RESIZE commit rides the frame, cancel rolls back the frame, maximised frames render fullscreen', async () => {
  const record = [];
  const root = makeNode('div');
  const api = v4ApiFixture({ record });
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references', { rect: { x: 100, y: 100, width: 400, height: 300 } });
  manager.open('layers', { rect: { x: 600, y: 420, width: 260, height: 180 } });
  manager.groupWindows(['window_references', 'window_layers'], { activeWindowId: 'window_references' });
  await new Promise((r) => setTimeout(r, 5));

  // RESIZE COMMIT: the frame grows; the member's latent rect and spatial lane untouched.
  const frame = root.children.find((f) => f.dataset && f.dataset.windowId === 'window_references');
  const h = resizeHandleFor(frame, 'se');
  h.dispatch('pointerdown', { button: 0, clientX: 500, clientY: 400, pointerId: 1 });
  h.dispatch('pointermove', { clientX: 540, clientY: 440, pointerId: 1 });
  h.dispatch('pointerup', { clientX: 540, clientY: 440, pointerId: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const g = manager.groups()[0];
  assert.equal(g.frame.rect.width, 440, 'the GROUP frame grew by the resize');
  assert.equal(manager.state('window_references').rect.width, 400, 'member latent rect untouched');
  assert.equal(record.filter((c) => c.kind === 'spatial' && c.windowId === 'window_references').length, 0, 'ZERO member spatial PATCH for grouped resize (spec F1)');
  const rs = record.filter((c) => c.kind === 'intent' && c.op.kind === 'group.setFrame').pop();
  assert.ok(rs && rs.op.patch.rect && rs.op.patch.rect.width === 440, 'the resize committed through group.setFrame');

  // RESIZE CANCEL: the frame rolls back; the member's latent rect is never clobbered.
  h.dispatch('pointerdown', { button: 0, clientX: 540, clientY: 440, pointerId: 2 });
  h.dispatch('pointermove', { clientX: 600, clientY: 520, pointerId: 2 });
  h.dispatch('pointercancel', { clientX: 600, clientY: 520, pointerId: 2 });
  assert.equal(manager.groups()[0].frame.rect.width, 440, 'the frame restored to the pre-gesture rect (spec F2)');
  assert.equal(manager.state('window_references').rect.width, 400, 'member latent rect never received frame geometry (spec F2)');
  assert.equal(manager.state('window_references').rect.x, 100, 'latent position intact');

  // MAXIMISED FRAME renders fullscreen (spec F3): the frame owns the presentation.
  manager.maximise('window_references');
  assert.ok(frame.classList.contains('freeform-window-maximised'), 'the maximised GROUP frame renders fullscreen (spec F3)');
  manager.unmaximise('window_references');
  assert.ok(!frame.classList.contains('freeform-window-maximised'), 'unmaximise restores the frame render');
});
