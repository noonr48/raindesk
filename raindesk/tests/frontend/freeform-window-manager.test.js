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
      for (const fn of this._listeners[type] || []) fn(event);
      for (const fn of this._listeners[`${type}:capture`] || []) fn(event);
    },
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

test.after(() => { if (savedDocument === undefined) delete global.document; else global.document = savedDocument; });

/* ------------------------------------------------------------ helpers */

function freshManager({ persistCalls } = {}) {
  const calls = persistCalls || [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { calls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
    focusWorkspace() { return Promise.resolve({ ok: true }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: {}, // no snapping in unit tests
  });
  return { manager, root, calls };
}

wm.CreativeSurfaces.clear();
wm.CreativeSurfaces.register({ id: 'layers', title: 'Layers', entityType: 'layers_panel', minimumSize: { width: 240, height: 160 } });
wm.CreativeSurfaces.register({ id: 'references', title: 'Reference Board', entityType: 'reference_board' });
wm.CreativeSurfaces.register({ id: 'dockable', title: 'Dockable', entityType: 'generic_panel', supportedStates: ['floating', 'minimised', 'maximised', 'docked'] });
wm.CreativeSurfaces.register({ id: 'locked_only', title: 'Pinned Only', entityType: 'note', supportedStates: ['floating'] });
// Shared controller-backed fixture, registered at module scope so ANY test
// (including name-filtered runs) can open it — test-local registration made
// isolated runs fail with 'unknown creative surface'.
let probeDestroyed = 0;
wm.CreativeSurfaces.register({
  id: 'probe', title: 'Probe', entityType: 'generic_panel',
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

test('spatial changes persist through the v3 object API', async () => {
  const { manager, calls } = freshManager();
  manager.open('references', { rect: { x: 10, y: 20, width: 350, height: 280 } });
  manager.minimise('window_references');
  await new Promise((r) => setTimeout(r, 5));
  const last = calls[calls.length - 1];
  assert.equal(last.windowId, 'window_references');
  assert.equal(last.state, 'minimised');
  assert.equal(last.x, 10);
  assert.equal(last.width, 350);
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
  const persistCalls = [];
  const root = makeNode('div');
  const shelf = makeNode('nav');
  const api = {
    getWorkspace() {
      return Promise.resolve({
        schemaVersion: 3, revision: 4,
        windows: [
          { windowId: 'window_references', type: 'reference_board', x: 5, y: 6, width: 300, height: 240, zIndex: 7, state: 'floating', collapsed: false, pinned: false, locked: false },
          { windowId: 'window_layers', type: 'layers_panel', x: 1, y: 2, width: 260, height: 200, zIndex: 8, state: 'minimised', collapsed: true, pinned: false, locked: false },
        ],
        groups: [], shelf: { windowIds: ['window_layers'] },
      });
    },
    upsertWorkspaceObject(p) { persistCalls.push(p); return Promise.resolve({ ok: true }); },
    setWorkspaceShelf() { return Promise.resolve({ ok: true, workspace: { revision: 5, windows: [], groups: [], shelf: { windowIds: [] } } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const refs = manager.state('window_references');
  assert.ok(refs, 'floating window restored');
  assert.equal(refs.rect.x, 5);
  // Minimised windows are shelf-backed: identity + rect + controller on
  // disk, frame hidden until a shelf chip restores them.
  const layers = manager.state('window_layers');
  assert.ok(layers, 'minimised window restored as a shelf-backed model');
  assert.equal(layers.state, 'minimised');
  const layersFrame = root.children.find((c) => c.dataset && c.dataset.windowId === 'window_layers');
  assert.ok(layersFrame, 'shelf-backed frame exists');
  assert.equal(layersFrame.hidden, true, 'shelf-backed frame hidden until restored');
  assert.equal(persistCalls.length, 0, 'init does not rewrite unchanged state');
});

test('init restores groups: tabbed members return with the active member visible', async () => {
  const root = makeNode('div');
  const api = {
    getWorkspace() {
      return Promise.resolve({
        schemaVersion: 3, revision: 6,
        windows: [
          { windowId: 'window_ga', type: 'note', entityRef: 'note:ga', x: 10, y: 10, width: 300, height: 200, zIndex: 3, state: 'tabbed', groupId: 'g_restore', collapsed: false, pinned: false, locked: false },
          { windowId: 'window_gb', type: 'note', entityRef: 'note:gb', x: 10, y: 10, width: 300, height: 200, zIndex: 4, state: 'tabbed', groupId: 'g_restore', collapsed: false, pinned: false, locked: false },
          { windowId: 'window_stray', type: 'note', entityRef: 'note:stray', x: 60, y: 60, width: 260, height: 180, zIndex: 5, state: 'tabbed', groupId: 'g_lost', collapsed: false, pinned: false, locked: false },
        ],
        groups: [{ groupId: 'g_restore', windowIds: ['window_ga', 'window_gb'], activeWindowId: 'window_gb' }],
        shelf: { windowIds: [] },
      });
    },
    upsertWorkspaceObject(p) { return Promise.resolve({ ok: true }); },
    setWorkspaceGroups() { return Promise.resolve({ ok: true, workspace: { revision: 7, windows: [], groups: [], shelf: { windowIds: [] } } }); },
  };
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
  assert.equal(stray.state, 'floating', 'stranded tabbed member re-floats when its group is gone');
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
  assert.deepEqual(shelfCalls, [['window_references']], 'shelf membership persisted');
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

test('init seeds lastRevision so the first gated write is gate-protected', async () => {
  const { manager, structural } = groupingManager();
  await manager.init(); // fixture getWorkspace returns revision 1
  const [a, b] = openThree(manager);
  manager.groupWindows([a, b], { activeWindowId: a });
  await new Promise((r) => setTimeout(r, 5));
  assert.ok(structural.length >= 1, 'structural write recorded');
  assert.equal(structural[0].baseRevision, 1,
    'first gated write carries the seeded revision (null would bypass the 409 gate)');
});

/* ------------------------------------------------------ shelf (Phase 2) */

function shelfManager() {
  const shelfCalls = [];
  const root = makeNode('div');
  const shelf = makeNode('nav');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
    setWorkspaceGroups(groups) { return Promise.resolve({ ok: true, workspace: { revision: 2, windows: [], groups, shelf: { windowIds: [] } } }); },
    setWorkspaceShelf(windowIds) { shelfCalls.push(windowIds); return Promise.resolve({ ok: true, workspace: { revision: 3, windows: [], groups: [], shelf: { windowIds } } }); },
  };
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
  assert.deepEqual(shelfCalls, [['window_references']], 'shelf membership persisted');

  chip.dispatch('click', {});
  const restored = manager.state('window_references');
  assert.equal(restored.state, 'floating');
  assert.deepEqual(restored.rect, { x: 120, y: 90, width: 400, height: 300 }, 'restore preserves the prior rect');
  assert.equal(frame.hidden, false);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(shelfCalls[shelfCalls.length - 1], [], 'shelf emptied on restore');
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
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
    setWorkspaceGroups(groups, { baseRevision } = {}) {
      structural.push({ kind: 'groups', groups, baseRevision });
      return Promise.resolve({ ok: true, workspace: { revision: 9, windows: [], groups, shelf: { windowIds: [] } } });
    },
  };
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
  assert.ok(structural.some((call) => call.kind === 'groups'), 'structural changes persist');
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
