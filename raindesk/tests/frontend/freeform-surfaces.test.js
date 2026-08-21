'use strict';

/*
 * Deterministic fake-DOM tests for the freeform surface registrations
 * (public/js/freeform-surfaces.js) — Phase 1 scenes/layers + Phase 3 unit 1
 * takes. The registry contract and controller behavior are checked without a
 * browser; the native smoke owns end-to-end mounting.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const { installSurfaces } = require(path.join(ROOT, 'public/js/freeform-surfaces.js'));

/* ---------------------------------------------------------- fake DOM */

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div'),
    children: [],
    dataset: {},
    _listeners: {},
    textContent: '',
    innerHTML: '',
    disabled: false,
    type: '',
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
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    append(...children) { for (const child of children) { child.parentNode = this; this.children.push(child); } },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, event) {
      event = event || {};
      event.target = event.target || this;
      event.preventDefault = event.preventDefault || (() => {});
      for (const fn of this._listeners[type] || []) fn(event);
    },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...node.classList._set].join(' '); },
    set(v) { node.classList._set = new Set(String(v).split(/\s+/).filter(Boolean)); },
  });
  return node;
}

const fakeDocument = { createElement: (t) => makeNode(t) };

/* ------------------------------------------------------------ fixture */

function install(defs = {}) {
  const registry = new Map();
  const surfaces = { register: (def) => { registry.set(def.id, def); } };
  const calls = { prev: 0, next: 0, commit: 0, discard: 0 };
  let takeState = { count: 0, index: -1 };
  let castState = null;
  const castCalls = [];
  let notesText = '';
  const notesCalls = [];
  const deps = {
    getBoard: defs.getBoard || (() => []),
    getActiveShotId: () => null,
    openShot: () => {},
    getLayers: defs.getLayers || (() => []),
    getActiveLayerId: () => null,
    setActiveLayer: () => false,
    addLayer: () => {},
    toggleLayerVisible: () => {},
    getTakeState: () => takeState,
    prevTake: () => { calls.prev += 1; takeState = { count: takeState.count, index: takeState.index - 1 }; },
    nextTake: () => { calls.next += 1; takeState = { count: takeState.count, index: takeState.index + 1 }; },
    commitTake: () => { calls.commit += 1; },
    discardTakes: () => { calls.discard += 1; takeState = { count: 0, index: -1 }; },
    getCastState: () => castState,
    toggleBound: (id) => { castCalls.push(id); },
    getNotes: () => notesText,
    setNotes: (t) => { notesText = String(t); notesCalls.push(String(t)); },
  };
  assert.equal(installSurfaces({ surfaces, deps }), true, 'installSurfaces completes');
  return { registry, deps, calls, castCalls, notesCalls, setTakeState: (s) => { takeState = s; }, setCastState: (s) => { castState = s; } };
}

function mount(registry, id) {
  const def = registry.get(id);
  assert.ok(def, `surface ${id} registered`);
  const body = makeNode('div');
  const controller = def.createController({ body, document: fakeDocument });
  return { body, controller };
}

function findButton(body, cls) {
  const walk = (n) => {
    for (const child of n.children || []) {
      if (child.tagName === 'button' && child.classList && child.classList.contains(cls)) return child;
      const hit = walk(child);
      if (hit) return hit;
    }
    return null;
  };
  return walk(body);
}

/* ------------------------------------------------------------- tests */

test('installSurfaces registers scenes, layers and takes with registry metadata', () => {
  const { registry } = install();
  assert.deepEqual([...registry.keys()].sort(), ['characters', 'layers', 'notes', 'scenes', 'takes']);
  const takes = registry.get('takes');
  assert.equal(takes.entityType, 'take_stack');
  assert.ok(Array.isArray(takes.supportedStates) && takes.supportedStates.includes('floating'));
  assert.ok(takes.minimumSize.width > 0 && takes.minimumSize.height > 0);
});

test('takes surface renders the empty state and disables every action', () => {
  const { registry } = install();
  const { body } = mount(registry, 'takes');
  const label = body.children[0] && body.children[0].children.find((c) => c.classList.contains('freeform-take-label'));
  assert.equal(label.textContent, 'no takes yet');
  for (const cls of ['freeform-take-prev', 'freeform-take-next', 'freeform-take-commit', 'freeform-take-discard']) {
    assert.equal(findButton(body, cls).disabled, true, `${cls} disabled with no takes`);
  }
});

test('takes surface tracks prev/next bounds and fires the deps seams', () => {
  const { registry, calls, setTakeState } = install();
  const { body, controller } = mount(registry, 'takes');
  setTakeState({ count: 3, index: 1 });
  controller.render();
  const label = body.children[0].children.find((c) => c.classList.contains('freeform-take-label'));
  assert.equal(label.textContent, 'take 2/3');
  const prev = findButton(body, 'freeform-take-prev');
  const next = findButton(body, 'freeform-take-next');
  const commit = findButton(body, 'freeform-take-commit');
  const discard = findButton(body, 'freeform-take-discard');
  assert.equal(prev.disabled, false);
  assert.equal(next.disabled, false);
  assert.equal(commit.disabled, false);
  assert.equal(discard.disabled, false);

  prev.dispatch('click');
  assert.equal(calls.prev, 1);
  assert.equal(label.textContent, 'take 1/3');

  setTakeState({ count: 3, index: 0 });
  controller.render();
  assert.equal(findButton(body, 'freeform-take-prev').disabled, true, 'prev disabled at first take');

  setTakeState({ count: 3, index: 2 });
  controller.render();
  assert.equal(findButton(body, 'freeform-take-next').disabled, true, 'next disabled at last take');

  commit.dispatch('click');
  assert.equal(calls.commit, 1);
  discard.dispatch('click');
  assert.equal(calls.discard, 1);
  assert.equal(label.textContent, 'no takes yet', 'discard resets the label');
});

test('takes surface re-renders through refreshAll (the syncDock seam contract)', () => {
  const { registry, setTakeState } = install();
  const { body, controller } = mount(registry, 'takes');
  // A new take arrives via GEN: app calls refreshAll -> controller.render.
  setTakeState({ count: 1, index: 0 });
  controller.render();
  const label = body.children[0].children.find((c) => c.classList.contains('freeform-take-label'));
  assert.equal(label.textContent, 'take 1/1');
  assert.equal(findButton(body, 'freeform-take-prev').disabled, true);
  assert.equal(findButton(body, 'freeform-take-next').disabled, true, 'single take: next disabled');
  assert.equal(findButton(body, 'freeform-take-commit').disabled, false, 'a take can be accepted');
});

test('characters surface registers with registry metadata', () => {
  const { registry } = install();
  const chars = registry.get('characters');
  assert.ok(chars, 'characters registered');
  assert.equal(chars.entityType, 'character_registry');
  assert.ok(chars.supportedStates.includes('floating'));
});

test('characters surface shows the offline empty state without cast data', () => {
  const { registry } = install();
  const { body } = mount(registry, 'characters');
  const empty = body.children[0].children.find((c) => c.classList.contains('freeform-character-empty'));
  assert.equal(empty.textContent, 'character registry offline (local server needed)');
});

test('characters surface renders bound/locked rows and fires toggleBound', () => {
  const { registry, castCalls, setCastState } = install();
  setCastState({
    shotId: 'S01',
    characters: [
      { id: 'lena', name: 'Lena', locked: true, anchors: [{ id: 'a1' }, { id: 'a2' }] },
      { id: 'mira', name: 'Mira', locked: false, anchors: [] },
    ],
    boundIds: ['lena'],
  });
  const { body, controller } = mount(registry, 'characters');
  const rows = body.children[0].children.filter((c) => c.classList.contains('freeform-character'));
  assert.equal(rows.length, 2);
  assert.ok(rows[0].classList.contains('bound'), 'lena is bound');
  assert.equal(rows[0].children.find((c) => c.classList.contains('lock')).textContent, '🔒');
  assert.equal(rows[0].children.find((c) => c.classList.contains('meta')).textContent, '2 anchors');
  assert.equal(rows[0].children.find((c) => c.classList.contains('cast')).textContent, 'in cast');
  assert.equal(rows[1].children.find((c) => c.classList.contains('cast')).textContent, 'add to cast');

  rows[1].children.find((c) => c.classList.contains('cast')).dispatch('click');
  assert.deepEqual(castCalls, ['mira'], 'cast button fires the toggleBound seam');
});

test('notes surface registers and round-trips typing through the deps seam', () => {
  const { registry, notesCalls } = install();
  const notes = registry.get('notes');
  assert.ok(notes, 'notes registered');
  assert.equal(notes.entityType, 'notes_panel');

  const body = makeNode('div');
  const controller = notes.createController({ body, document: fakeDocument });
  const ta = body.children[0];
  assert.ok(ta.classList.contains('freeform-notes-area'), 'textarea mounted');

  ta.value = 'hold on Lena longer';
  ta.dispatch('input');
  assert.deepEqual(notesCalls, ['hold on Lena longer'], 'typing persists through setNotes');

  // render() restores stored text when it diverges (e.g. reload restore).
  const body2 = makeNode('div');
  const c2 = notes.createController({ body: body2, document: fakeDocument });
  assert.equal(body2.children[0].value, 'hold on Lena longer', 'restore renders the persisted text');

  // render() must not clobber in-progress typing when text already matches.
  c2.render();
  assert.equal(body2.children[0].value, 'hold on Lena longer');
  controller.destroy();
});
