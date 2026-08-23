'use strict';

/*
 * Deterministic fake-DOM tests for the freeform surface registrations
 * (public/js/freeform-surfaces.js) — Phase 1 scenes/layers + Phase 3 unit 1
 * takes. The registry contract and controller behavior are checked without a
 * browser; the native smoke owns end-to-end mounting.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    setAttribute(k, v) { this._attrs = this._attrs || {}; this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs && Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    removeAttribute(k) { if (this._attrs) delete this._attrs[k]; },
    hasAttribute(k) { return Boolean(this._attrs && Object.prototype.hasOwnProperty.call(this._attrs, k)); },
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
  let proposals = [];
  const proposalCalls = [];
  const refreshCalls = [];
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
    mountBeatTrail: defs.mountBeatTrail || null,
    getNotes: () => notesText,
    setNotes: (t) => { notesText = String(t); notesCalls.push(String(t)); },
    getProposals: () => proposals,
    applyProposal: (id) => { proposalCalls.push(['apply', id]); },
    cancelProposal: (id) => { proposalCalls.push(['cancel', id]); },
    refreshCast: () => { refreshCalls.push('cast'); },
    refreshProposals: () => { refreshCalls.push('proposals'); },
  };
  assert.equal(installSurfaces({ surfaces, deps }), true, 'installSurfaces completes');
  return { registry, deps, calls, castCalls, notesCalls, proposalCalls, refreshCalls, setTakeState: (s) => { takeState = s; }, setCastState: (s) => { castState = s; }, setProposals: (p) => { proposals = p; } };
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

function hostOf(body, cls) {
  return body.children.find((c) => c.classList && c.classList.contains(cls));
}

/* ------------------------------------------------------------- tests */

test('installSurfaces registers scenes, layers, takes and beats with registry metadata', () => {
  const { registry } = install();
  assert.deepEqual([...registry.keys()].sort(), ['beats', 'characters', 'layers', 'notes', 'proposals', 'scenes', 'takes']);
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
  const empty = hostOf(body, 'freeform-character-rows').children.find((c) => c.classList.contains('freeform-character-empty'));
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
  const rows = hostOf(body, 'freeform-character-rows').children.filter((c) => c.classList.contains('freeform-character'));
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

/* ------------------------------------------------- beats surface (Phase 3) */

test('beats surface registers with beat_trail metadata and the beats: entityRef namespace', () => {
  const { registry } = install();
  const beats = registry.get('beats');
  assert.ok(beats, 'beats registered');
  assert.equal(beats.entityType, 'beat_trail');
  // Partner move_panel compatibility: the durable window object keeps a
  // typed entityRef inside the documented beats: namespace.
  assert.equal(beats.entityRefPrefix, 'beats');
  assert.ok(beats.supportedStates.includes('floating') && beats.supportedStates.includes('minimised'));
  assert.ok(beats.minimumSize.width > 0 && beats.minimumSize.height > 0);
});

test('opening the beats surface mounts the EXISTING trail content into the window body', () => {
  const mountedHosts = [];
  const { registry } = install({
    mountBeatTrail(host) {
      mountedHosts.push(host);
      const root = makeNode('div');
      root.classList.add('beat-trail');
      host.appendChild(root);
      return { render() {}, destroy() {} };
    },
  });
  const { body, controller } = mount(registry, 'beats');
  assert.equal(mountedHosts.length, 1, 'the trail mounts once per window open');
  assert.equal(mountedHosts[0], body, 'the trail mounts into the registry window body');
  assert.ok(hostOf(body, 'beat-trail'), 'existing beats.js content renders unrewritten');
  controller.destroy();
});

test('shot-change refresh updates trail content through the registry lifecycle', () => {
  let spec = { shotId: 'S01', beats: [{ id: 'b1', rawDirection: 'she turns her head' }] };
  let rowRef = null;
  const { registry } = install({
    mountBeatTrail(host) {
      const row = makeNode('div');
      row.classList.add('beat-row');
      host.appendChild(row);
      rowRef = row;
      return {
        render() { row.textContent = `${spec.shotId}:${spec.beats.map((b) => b.rawDirection).join('|')}`; },
        destroy() {},
      };
    },
  });
  const { controller } = mount(registry, 'beats');
  controller.render();
  assert.equal(rowRef.textContent, 'S01:she turns her head');
  // Shot changes while the window is open, minimised or grouped: the
  // instance persists, so refreshAll -> controller.render shows the new shot.
  spec = { shotId: 'S02', beats: [{ id: 'b2', rawDirection: 'he lunges' }] };
  controller.render();
  assert.equal(rowRef.textContent, 'S02:he lunges', 'content follows the shot change');
});

test('beats surface shows an honest empty state when no trail seam is provided', () => {
  const { registry } = install(); // no mountBeatTrail dep
  const { body } = mount(registry, 'beats');
  assert.ok(hostOf(body, 'freeform-beat-empty'), 'fallback note instead of a dead window');
});

test('desktop Beats entry point routes through the registry window; bespoke shell is gated off there', () => {
  const appSource = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  // Tool click delegates to the registry window first...
  const toolAt = appSource.indexOf("t === 'beats'");
  assert.notEqual(toolAt, -1, 'beats tool binding present');
  const branch = appSource.slice(toolAt, appSource.indexOf('\n', toolAt));
  assert.match(branch, /toggleBeatsSurface\(\)/, 'entry point opens/focuses window_beats');
  // ...and only falls back to the bespoke shell where freeform never mounted
  // (default experience / sub-900px legacy path stays intact).
  assert.match(branch, /state\.beatTrail\.toggle\(\)/);
  assert.match(appSource, /if \(!toggleBeatsSurface\(\) && state\.beatTrail\) state\.beatTrail\.toggle\(\)/);
  // panel_beats is not registered on the freeform desktop path.
  const regionStart = appSource.indexOf("id: 'panel_layers'");
  const regionEnd = appSource.indexOf("id: 'panel_partner'");
  const region = appSource.slice(regionStart, regionEnd);
  assert.match(region, /if \(!useFreeformDesk\) \{[\s\S]*id: 'panel_beats'/,
    'bespoke panel_beats registration is skipped when the registry desk mounts');
  // The registry window opens with a beats:-namespaced entityRef.
  assert.match(appSource, /open\('beats', \{ entityRef: 'beats:[A-Za-z0-9_.-]+' \}\)/);
});

test('proposals surface shows the empty state with no pending suggestions', () => {
  const { registry } = install();
  const { body } = mount(registry, 'proposals');
  const empty = hostOf(body, 'freeform-proposal-rows').children.find((c) => c.classList.contains('freeform-proposal-empty'));
  assert.equal(empty.textContent, 'no spatial suggestions right now');
});

test('contextual strips render per-surface quick actions and fire their seams', () => {
  const { registry, refreshCalls } = install();

  const castBody = makeNode('div');
  registry.get('characters').createController({ body: castBody, document: fakeDocument });
  const castStrip = hostOf(castBody, 'freeform-context-actions');
  assert.ok(castStrip, 'strip mounts in the body');
  const castBtn = castStrip.children[0];
  assert.equal(castBtn.textContent, 'refresh cast');
  castBtn.dispatch('click');
  assert.deepEqual(refreshCalls, ['cast']);

  const propBody = makeNode('div');
  registry.get('proposals').createController({ body: propBody, document: fakeDocument });
  const propBtn = hostOf(propBody, 'freeform-context-actions').children[0];
  assert.equal(propBtn.textContent, 'refresh');
  propBtn.dispatch('click');
  assert.deepEqual(refreshCalls, ['cast', 'proposals']);

  // Surfaces without contextual actions keep their bodies unchanged.
  const notesBody = makeNode('div');
  registry.get('notes').createController({ body: notesBody, document: fakeDocument });
  assert.ok(!hostOf(notesBody, 'freeform-context-actions'));
});

test('proposals surface lists only proposed actions and fires apply/dismiss seams', () => {
  const { registry, proposalCalls, setProposals } = install();
  setProposals([
    { id: 'a1', type: 'move_panel', label: 'stage layers beside scenes', status: 'proposed', executable: true },
    { id: 'a2', type: 'create_scene', label: 'advisory idea', status: 'proposed', executable: false },
    { id: 'a3', type: 'focus', label: 'already done', status: 'completed', executable: true },
  ]);
  const { body, controller } = mount(registry, 'proposals');
  const rows = hostOf(body, 'freeform-proposal-rows').children.filter((c) => c.classList.contains('freeform-proposal'));
  assert.equal(rows.length, 2, 'only proposed actions render');
  assert.equal(rows[0].children.find((c) => c.classList.contains('nm')).textContent, 'stage layers beside scenes');
  assert.equal(rows[0].children.find((c) => c.classList.contains('freeform-proposal-apply')).textContent, 'apply');
  assert.equal(rows[1].children.find((c) => c.classList.contains('meta')).textContent, 'advisory',
    'non-executable proposal shows advisory note without apply');
  assert.ok(!rows[1].children.find((c) => c.classList.contains('freeform-proposal-apply')),
    'advisory row has no apply button');

  rows[0].children.find((c) => c.classList.contains('freeform-proposal-apply')).dispatch('click');
  assert.deepEqual(proposalCalls[0], ['apply', 'a1']);
  rows[1].children.find((c) => c.classList.contains('freeform-proposal-dismiss')).dispatch('click');
  assert.deepEqual(proposalCalls[1], ['cancel', 'a2']);

  // After apply the proposal leaves the pending list (re-render contract).
  setProposals([{ id: 'a1', type: 'move_panel', label: 'staged', status: 'completed', executable: true }]);
  controller.render();
  const empty = hostOf(body, 'freeform-proposal-rows').children.find((c) => c.classList.contains('freeform-proposal-empty'));
  assert.ok(empty, 'completed actions no longer surface');
});
