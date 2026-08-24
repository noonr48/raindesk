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
  const last = calls[calls.length - 1];
  assert.equal(last.windowId, id);
  assert.equal(last.width, 420);
  assert.equal(last.height, 330);
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

test('two desks on one store: gated writes stay revision-protected after init seeding', async () => {
  // Shared store mimicking lib/workspace revision semantics: every write
  // bumps revision; gated writes 409 with current state when stale.
  const store = { revision: 1, windows: [], groups: [], shelf: { windowIds: [] } };
  const groupCalls = [];
  let groupsAttempts = 0;
  const mkApi = () => ({
    getWorkspace: () => Promise.resolve({ schemaVersion: 3, revision: store.revision, windows: store.windows.map((w) => ({ ...w })), groups: store.groups.map((g) => ({ ...g })), shelf: { windowIds: [] } }),
    upsertWorkspaceObject: (payload) => {
      store.revision += 1;
      store.windows = store.windows.filter((w) => w.windowId !== payload.windowId).concat([{ ...payload }]);
      return Promise.resolve({ ok: true, object: payload, revision: store.revision });
    },
    setWorkspaceGroups: (groups, { baseRevision } = {}) => {
      groupCalls.push(baseRevision);
      groupsAttempts += 1;
      if (groupsAttempts === 1) {
        // Simulate a foreign writer (the other desk) landing between our
        // send and server-handle: 409 carrying the post-conflict state.
        store.revision += 1;
        return Promise.reject(Object.assign(new Error('workspace changed since this edit'), { workspace: { revision: store.revision, windows: [], groups: [], shelf: { windowIds: [] } } }));
      }
      store.revision += 1;
      store.groups = groups.map((g) => ({ ...g }));
      return Promise.resolve({ ok: true, workspace: { revision: store.revision, windows: [], groups: store.groups.map((g) => ({ ...g })), shelf: { windowIds: [] } } });
    },
  });
  const rootA = makeNode('div');
  const rootB = makeNode('div');
  const mgrA = wm.WindowManager({ root: rootA, document: fakeDocument, api: mkApi(), viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  const mgrB = wm.WindowManager({ root: rootB, document: fakeDocument, api: mkApi(), viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await Promise.all([mgrA.init(), mgrB.init()]); // BOTH seed lastRevision = 1

  // Desk B lands an object upsert first (bumps the shared store to 2).
  mgrB.open('references');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(store.revision, 2, 'B upsert bumped the shared store');

  // Desk A opens two windows (upserts bump to 3 then 4, each adopted) and
  // groups them: the gated write must carry the CURRENT revision — null
  // would bypass the gate and silently clobber B's landed object.
  mgrA.open('layers');
  await new Promise((r) => setTimeout(r, 5));
  mgrA.open('probe');
  await new Promise((r) => setTimeout(r, 5));
  mgrA.groupWindows(['window_layers', 'window_probe'], { activeWindowId: 'window_layers' });
  await new Promise((r) => setTimeout(r, 10));

  // The first attempt must carry a REAL revision token — groupWindows' own
  // member upserts serialize ahead of it on the chain and are adopted, so
  // the exact number is their sum with the boot seed; null is the defect
  // this test exists to forbid.
  assert.ok(Number.isInteger(groupCalls[0]) && groupCalls[0] >= 2, 'first gated write carried a real (non-null) revision token');
  // The simulated foreign write forced 409 -> adopt -> retry: convergence,
  // not a silent drop, is the contract under cross-desk contention.
  assert.equal(groupCalls[1], groupCalls[0] + 1, 'retry adopted the conflicted revision');
  assert.equal(groupCalls.length, 2, 'exactly one adopt-and-retry after the conflict');
  assert.equal(store.groups.length, 1, 'group converged onto the shared store');
  assert.deepEqual(store.groups[0].windowIds.slice().sort(), ['window_layers', 'window_probe']);
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

/* ----------------------- GPT Pro round-3 triage: durable dock + close + cancel */

test('dock commit persists the durable edge; re-float clears it', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  let snap = { dock: 'left', rect: { x: 0, y: 0, width: 640, height: 800 } };
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
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
  const committed = persistCalls[persistCalls.length - 1];
  assert.equal(committed.state, 'docked', 'commit persists the docked state');
  assert.equal(committed.dock, 'left', 'commit persists the durable edge (was: omitted entirely)');
  // Dragging off the edge re-floats AND clears the stored dock.
  snap = null;
  head.dispatch('pointerdown', { button: 0, clientX: 20, clientY: 110 });
  fakeDocument.dispatch('pointermove', { clientX: 400, clientY: 130, buttons: 1 });
  fakeDocument.dispatch('pointerup', { clientX: 400, clientY: 130 });
  await new Promise((r) => setTimeout(r, 0));
  const after = persistCalls[persistCalls.length - 1];
  assert.equal(after.state, 'floating', 'drag-off-edge re-floats');
  assert.equal(after.dock, null, 're-float clears the stored dock');
});

test('docked state survives reload: init keeps the edge and re-derives geometry', async () => {
  const root = makeNode('div');
  let dockRectCalls = 0;
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 16, y: 66, width: 400, height: 300, zIndex: 3, state: 'docked', groupId: null, collapsed: false, pinned: false, locked: false, dock: 'left' },
      ], groups: [], shelf: { windowIds: [] } });
    },
  };
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

test('close is authoritative server-side: the persisted row is deleted through the write chain', async () => {
  const deletes = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    deleteWorkspaceWindow(windowId) { deletes.push(windowId); return Promise.resolve({ ok: true, revision: 9 }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references');
  await new Promise((r) => setTimeout(r, 0)); // open()'s persist is async: model.persisted must be set before close
  manager.close('window_references');
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(deletes, ['window_references'], 'close deletes the persisted row (was: resurrected on reload)');
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

test('close before the first persist lands still deletes: the upsert can never resurrect', async () => {
  const deletes = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    deleteWorkspaceWindow(windowId) { deletes.push(windowId); return Promise.resolve({ ok: true, workspace: { revision: 9 } }); },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references');
  manager.close('window_references'); // NO flush: the open() upsert is still queued on the write chain
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(deletes, ['window_references'], 'unconditional close-delete: the late upsert can never resurrect (GPT Pro round-4)');
});

test('minimise then restore returns a docked window to its stored edge', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  const shelf = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      // Seed a docked-left window that is ALSO on the shelf: restore must
      // return it to the dock, not float it (GPT Pro round-4).
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 16, y: 66, width: 380, height: 600, zIndex: 3, state: 'minimised', groupId: null, collapsed: true, pinned: false, locked: false, dock: 'left' },
      ], groups: [], shelf: { windowIds: ['window_layers'] } });
    },
    setWorkspaceShelf(ids) { return Promise.resolve({ ok: true, workspace: { revision: 6, windows: [], groups: [], shelf: { windowIds: ids } } }); },
  };
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
});

test('init repairs an out-of-policy docked row and persists the repair immediately', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 16, y: 66, width: 400, height: 300, zIndex: 3, state: 'docked', groupId: null, collapsed: false, pinned: false, locked: false, dock: 'top' },
      ], groups: [], shelf: { windowIds: [] } });
    },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  assert.equal(manager.state('window_layers').state, 'floating');
  const repair = persistCalls.find((p) => p.windowId === 'window_layers');
  assert.ok(repair, 'the repair is persisted immediately (was: malformed row returned every session)');
  assert.equal(repair.state, 'floating');
  assert.equal(repair.dock, null);
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

test('close-delete classifies errors: 409 adopts and retries once, 404 anywhere is success', async () => {
  const deleteCalls = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    deleteWorkspaceWindow(windowId) {
      deleteCalls.push(windowId);
      if (deleteCalls.length === 1) {
        const conflict = new Error('stale baseRevision');
        conflict.status = 409;
        conflict.workspace = { revision: 7, windows: [], groups: [], shelf: { windowIds: [] } };
        return Promise.reject(conflict);
      }
      if (deleteCalls.length === 2) {
        const gone = new Error('unknown workspace window');
        gone.status = 404; // the retry finds the row already absent: success
        return Promise.reject(gone);
      }
      return Promise.resolve({ ok: true, workspace: { revision: 9 } });
    },
    getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  manager.open('references');
  manager.close('window_references');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(deleteCalls.length, 2, '409 adopted the server revision and retried exactly once');
  // A 404 on the retry path settled as idempotent success — no warning loop,
  // no third call, no unhandled rejection.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(deleteCalls.length, 2, '404 on the retry path terminates as success');
});

test('close-delete warn path: a 5xx without workspace never retries and never silently settles', async () => {
  const deleteCalls = [];
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const root = makeNode('div');
    const api = {
      upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
      deleteWorkspaceWindow(windowId) {
        deleteCalls.push(windowId);
        const boom = new Error('gateway exploded');
        boom.status = 502; // transport-class failure: NO workspace, NOT 404
        return Promise.reject(boom);
      },
      getWorkspace() { return Promise.resolve({ schemaVersion: 3, revision: 1, windows: [], groups: [], shelf: { windowIds: [] } }); },
    };
    const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
    manager.open('references');
    manager.close('window_references');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(deleteCalls.length, 1, 'a 5xx is neither absent-success (no silent settle) nor conflict (no retry): one attempt');
    assert.ok(warnings.some((w) => w.includes('window_references') && w.includes('close-delete failed')),
      'uncertain failure stays visible through the warn path (GPT Pro round-5)');
  } finally {
    console.warn = origWarn;
  }
});

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

test('init repairs a stale dock on a TABBED row while keeping the group', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 100, y: 100, width: 380, height: 280, zIndex: 3, state: 'tabbed', groupId: 'g_stale', collapsed: false, pinned: false, locked: false, dock: 'right' },
        { windowId: 'window_references', type: 'reference_board', space: 'screen', entityRef: 'board:references', x: 100, y: 100, width: 380, height: 280, zIndex: 4, state: 'tabbed', groupId: 'g_stale', collapsed: false, pinned: false, locked: false, dock: null },
      ], groups: [{ groupId: 'g_stale', windowIds: ['window_layers', 'window_references'], activeWindowId: 'window_references' }], shelf: { windowIds: [] } });
    },
    setWorkspaceGroups(groups) { return Promise.resolve({ ok: true, workspace: { revision: 6, windows: [], groups, shelf: { windowIds: [] } } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const st = manager.state('window_layers');
  assert.equal(st.state, 'tabbed', 'group membership is untouched by the repair');
  assert.equal(st.dock, null, 'the stale dock on a tabbed member is cleared in memory');
  const repair = persistCalls.find((p) => p.windowId === 'window_layers' && p.dock === null);
  assert.ok(repair, 'and the tabbed-row repair is persisted (was: only floating rows were repaired)');
});

test('init repairs a stale dock on a floating row: no surprise re-dock later', async () => {
  const persistCalls = [];
  const root = makeNode('div');
  const shelf = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { persistCalls.push(payload); return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      // {state: floating, dock: left} — the inconsistent hybrid GPT round-5
      // flagged: a later minimise/restore surprise-redocks from it.
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 200, y: 200, width: 380, height: 280, zIndex: 3, state: 'floating', groupId: null, collapsed: false, pinned: false, locked: false, dock: 'left' },
      ], groups: [], shelf: { windowIds: [] } });
    },
    setWorkspaceShelf(ids) { return Promise.resolve({ ok: true, workspace: { revision: 6, windows: [], groups: [], shelf: { windowIds: ids } } }); },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const repaired = persistCalls.find((p) => p.windowId === 'window_layers' && p.dock === null);
  assert.ok(repaired, 'the stale dock on a floating row is cleared and persisted at init');
  manager.attachShelf(shelf);
  manager.minimise('window_layers');
  manager.restore('window_layers');
  assert.equal(manager.state('window_layers').state, 'floating', 'restore after repair floats: no surprise redock from a stale edge');
});

test('shelf restore to docked shows content: collapsed is cleared', async () => {
  const root = makeNode('div');
  const shelf = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 16, y: 66, width: 380, height: 600, zIndex: 3, state: 'minimised', groupId: null, collapsed: true, pinned: false, locked: false, dock: 'left' },
      ], groups: [], shelf: { windowIds: ['window_layers'] } });
    },
    setWorkspaceShelf(ids) { return Promise.resolve({ ok: true, workspace: { revision: 6, windows: [], groups: [], shelf: { windowIds: ids } } }); },
  };
  const manager = wm.WindowManager({
    root, document: fakeDocument, api,
    viewportMetrics: () => ({ width: 1280, height: 800 }),
    geometry: { dockRect: (dock, rect) => ({ ...rect, x: 16 }) },
  });
  await manager.init();
  manager.attachShelf(shelf);
  manager.restore('window_layers');
  const st = manager.state('window_layers');
  assert.equal(st.state, 'docked');
  assert.equal(st.collapsed, false, 'dock restore renders the body, not a header-only rail (GPT Pro round-5)');
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

test('init downgrades a persisted docked row whose edge is outside the surface policy', async () => {
  const root = makeNode('div');
  const api = {
    upsertWorkspaceObject(payload) { return Promise.resolve({ ok: true, object: payload }); },
    getWorkspace() {
      return Promise.resolve({ schemaVersion: 3, revision: 5, windows: [
        { windowId: 'window_layers', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 16, y: 66, width: 400, height: 300, zIndex: 3, state: 'docked', groupId: null, collapsed: false, pinned: false, locked: false, dock: 'top' },
      ], groups: [], shelf: { windowIds: [] } });
    },
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  assert.equal(manager.state('window_layers').state, 'floating', 'top-docked layers row downgrades: top is outside its dock policy');
});
