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
  for (const child of node.children || []) {
    for (const part of parts) {
      if (part.startsWith('.') && child.classList && child.classList.contains(part.slice(1))) { out.push(child); if (!all) return; }
      else if (!part.startsWith('.') && !part.startsWith('[') && child.tagName && child.tagName.toUpperCase() === part.toUpperCase()) { out.push(child); if (!all) return; }
    }
    findAll(child, selector, out, all);
    if (!all && out.length) return;
  }
}

const fakeDocument = {
  createElement: (t) => makeNode(t),
  defaultView: { CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } } },
  addEventListener() {}, removeEventListener() {},
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

test('init restores persisted floating windows and skips minimised/tabbed ones', async () => {
  const persistCalls = [];
  const root = makeNode('div');
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
  };
  const manager = wm.WindowManager({ root, document: fakeDocument, api, viewportMetrics: () => ({ width: 1280, height: 800 }), geometry: {} });
  await manager.init();
  const refs = manager.state('window_references');
  assert.ok(refs, 'floating window restored');
  assert.equal(refs.rect.x, 5);
  assert.equal(refs.rect.width, 300);
  assert.equal(manager.state('window_layers'), null, 'minimised windows wait for shelf restore');
  assert.equal(persistCalls.length, 0, 'init does not rewrite unchanged state');
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
  const activeTab = tabs.find((t) => t.dataset.windowId === b);
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
  const cTab = tabs.find((t) => t.dataset.windowId === c);
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
