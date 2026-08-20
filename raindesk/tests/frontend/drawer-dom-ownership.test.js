'use strict';

/*
 * Behavioral DOM-ownership proofs for the drawer takes surfaces.
 *
 * These execute the REAL ChatDrawer (public/js/chat.js) and the REAL
 * AnimaticTakes controller (public/js/animatic-takes.js) against a minimal
 * fake DOM — the same DI style as animatic-pacing.test.js, extended to a
 * node graph because ChatDrawer builds its own subtree. The native
 * acceptance journey remains dev/browser-animatic-reload-smoke.js; these
 * prove the interleavings the browser cannot cheaply force.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');

/* ------------------------------------------------ fake DOM */

function makeNode(tag) {
  const node = {
    tagName: String(tag || 'div'),
    children: [],
    dataset: {},
    style: {},
    _listeners: {},
    _attrs: {},
    textContent: '',
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
    appendChild(child) { this.children.push(child); return child; },
    append(...children) { this.children.push(...children); },
    removeChild(child) { const i = this.children.indexOf(child); if (i >= 0) this.children.splice(i, 1); },
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
    dispatch(type, event) { for (const fn of this._listeners[type] || []) fn(event || { preventDefault() {} }); },
    contains(other) { return this === other || this.children.some((c) => c && typeof c.contains === 'function' && c.contains(other)); },
    set innerHTML(v) { if (v === '') this.children.length = 0; this._innerHTML = v; },
    get innerHTML() { return this._innerHTML || ''; },
  };
  const classes = new Set();
  node.classList = {
    add: (...cs) => cs.forEach((c) => classes.add(c)),
    remove: (...cs) => cs.forEach((c) => classes.delete(c)),
    toggle(c, on) {
      if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
      else if (on) classes.add(c); else classes.delete(c);
      return classes.has(c);
    },
    contains: (c) => classes.has(c),
  };
  Object.defineProperty(node, 'className', {
    get: () => [...classes].join(' '),
    set: (v) => { classes.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c)); },
  });
  return node;
}

const fakeDocument = { createElement: (t) => makeNode(t) };
const savedDocument = global.document;
global.document = fakeDocument;
// no global.localStorage on purpose: ChatDrawer must tolerate its absence and
// animatic takes must never depend on it.

const chat = require(path.join(ROOT, 'public', 'js', 'chat.js'));
const takes = require(path.join(ROOT, 'public', 'js', 'animatic-takes.js'));

function findAll(node, cls, out = []) {
  for (const child of node.children || []) {
    if (String(child.className).split(/\s+/).includes(cls)) out.push(child);
    findAll(child, cls, out);
  }
  return out;
}
const tick = (n = 6) => new Promise((resolve) => setTimeout(resolve, n * 3));

const keptRecord = {
  candidate: { candidate_id: 'cand-x', media: { duration: { num: 3, den: 1 } } },
  review: { isCurrentKeep: true },
  artifacts: [{ url: '/api/animatic/artifact/sha' }],
};
const imageTake = (prompt) => ({ shotId: 'S01', shotLabel: 'S01', prompt, imageUrl: null, committed: true });

function makeDrawer(api) {
  const root = makeNode('div');
  const drawer = chat.ChatDrawer(root, { api });
  const gensList = findAll(root, 'gens-list')[0];
  const animaticHost = gensList && (findAll(gensList, 'animatic-takes-host')[0] || findAll(gensList, 'animatic-takes-section')[0]);
  const imageHost = gensList && findAll(gensList, 'image-takes-host')[0];
  return { root, drawer, gensList, animaticHost, imageHost };
}

test.after(() => { if (savedDocument === undefined) delete global.document; else global.document = savedDocument; });

/* ------------------------------------------------ ownership */

test('drawer builds one stable host per takes surface', () => {
  const { gensList, animaticHost, imageHost } = makeDrawer({ listTakes: async () => ({ takes: [] }) });
  assert.ok(animaticHost, 'animatic host exists inside gens list');
  assert.ok(imageHost, 'image host exists inside gens list');
  assert.equal(gensList.children.length, 2, 'hosts are the only gens-list children');
});

test('image-Take redraw cannot erase animatic takes (and vice versa)', async () => {
  const api = {
    listTakes: async () => ({ takes: [imageTake('first image take')] }),
    listAnimaticCandidates: async () => ({ candidates: [keptRecord] }),
  };
  const { drawer, animaticHost, imageHost } = makeDrawer(api);
  takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: animaticHost });

  drawer.open('gens');
  await tick();

  assert.equal(findAll(animaticHost, 'animatic-take-card').length, 1, 'animatic card rendered');
  assert.equal(findAll(imageHost, 'gen-row').length, 1, 'image row rendered');

  // A later image redraw (e.g. recordGen while open, or repeated open) must
  // not touch the animatic host.
  drawer.open('agent'); drawer.open('gens');
  await tick();
  assert.equal(findAll(animaticHost, 'animatic-take-card').length, 1, 'animatic card survived image redraw');
  assert.equal(findAll(imageHost, 'gen-row').length, 1, 'image row survived animatic render');

  // And a later animatic render must not touch image rows.
  const controller2 = takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: animaticHost });
  controller2.render();
  await tick();
  assert.equal(findAll(imageHost, 'gen-row').length, 1, 'image row survived a second animatic render');
  assert.equal(findAll(animaticHost, 'animatic-take-card').length, 1);
});

test('repeated tab activation is idempotent', async () => {
  const api = {
    listTakes: async () => ({ takes: [imageTake('only take')] }),
    listAnimaticCandidates: async () => ({ candidates: [keptRecord] }),
  };
  const { drawer, animaticHost, imageHost } = makeDrawer(api);
  takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: animaticHost });
  for (let i = 0; i < 4; i++) { drawer.open('agent'); drawer.open('gens'); }
  await tick(10);
  assert.equal(findAll(animaticHost, 'animatic-take-card').length, 1);
  assert.equal(findAll(imageHost, 'gen-row').length, 1);
});

test('a stale image-Take response cannot overwrite a newer render', async () => {
  let releaseOld;
  const oldResponse = new Promise((resolve) => { releaseOld = resolve; });
  let calls = 0;
  const api = {
    listTakes: async () => {
      calls += 1;
      if (calls === 1) return oldResponse; // delayed first response
      return { takes: [imageTake('new take')] };
    },
    listAnimaticCandidates: async () => ({ candidates: [] }),
  };
  const { drawer, imageHost } = makeDrawer(api);
  takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: null });

  drawer.open('gens');          // starts render 1 (pending on oldResponse)
  drawer.open('agent');
  drawer.open('gens');          // render 2 supersedes render 1
  await tick();
  releaseOld({ takes: [imageTake('stale take')] }); // render 1 finally resolves
  await tick();

  const prompts = findAll(imageHost, 'gen-prompt').map((n) => n.textContent);
  assert.ok(prompts.includes('new take'), `new take rendered (${prompts.join(',')})`);
  assert.ok(!prompts.includes('stale take'), 'stale response discarded by the epoch guard');
});

test('a stale animatic response cannot overwrite a newer render', async () => {
  let releaseOld;
  const oldResponse = new Promise((resolve) => { releaseOld = resolve; });
  let calls = 0;
  const api = {
    listTakes: async () => ({ takes: [] }),
    listAnimaticCandidates: async () => {
      calls += 1;
      if (calls === 1) return oldResponse;
      return { candidates: [keptRecord] };
    },
  };
  const { drawer, animaticHost } = makeDrawer(api);
  const controller = takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: animaticHost });

  controller.render();          // render 1 pending
  controller.render();          // render 2 supersedes
  await tick();
  releaseOld({ candidates: [{ candidate: { candidate_id: 'stale' }, review: {}, artifacts: [] }] });
  await tick();

  assert.equal(findAll(animaticHost, 'animatic-take-card').length, 1);
  assert.ok(animaticHost.children.some((c) => String(c.className).includes('animatic-take-card')));
  const cards = findAll(animaticHost, 'animatic-take-card');
  assert.equal(cards[0].dataset.candidateId, 'cand-x', 'newest response owns the host');
});

test('tab lifecycle channel restores server-owned Keep state on a fresh drawer', async () => {
  const api = {
    listTakes: async () => ({ takes: [] }),
    listAnimaticCandidates: async () => ({ candidates: [keptRecord] }),
  };
  // A brand-new ChatDrawer instance — the fresh-page scenario.
  const { root, drawer, animaticHost } = makeDrawer(api);
  takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: animaticHost });
  drawer.open('agent');         // constructor/open default tab — must not render takes
  await tick();
  assert.equal(findAll(animaticHost, 'animatic-take-card').length, 0, 'agent tab does not fetch candidates');
  // The drawer's own tab node dispatches through chat.js's real click
  // handler -> sync() -> tab broadcast (no per-feature hooks involved).
  const gensTab = findAll(root, 'dtab').find((n) => n.dataset && n.dataset.tab === 'gens');
  assert.ok(gensTab, 'gens tab node exists in the drawer DOM');
  gensTab.dispatch('click');
  await tick();
  const status = findAll(animaticHost, 'animatic-take-status')[0];
  assert.ok(status, 'take status rendered');
  assert.match(status.textContent, /kept/, 'server-owned Keep state restored');
});

test('animatic takes never depend on localStorage', async () => {
  const api = {
    listTakes: async () => ({ takes: [] }),
    listAnimaticCandidates: async () => ({ candidates: [keptRecord] }),
  };
  // Node ships a real global localStorage (v22+); spy it with argument capture
  // during the restore. The proof: restoration succeeds and the animatic path
  // performs ZERO localStorage reads or writes of any raindesk key — the spy
  // records method + key arguments, so the assertion is falsifiable.
  const accesses = [];
  const savedLS = global.localStorage;
  global.localStorage = new Proxy({}, {
    get(_t, prop) {
      accesses.push(`access:${String(prop)}`);
      if (prop === 'getItem' || prop === 'setItem' || prop === 'removeItem' || prop === 'key') {
        return (...args) => {
          accesses.push(`${String(prop)}:${args.map((a) => String(a)).join(',')}`);
          return null;
        };
      }
      return () => null;
    },
    set(_t, prop) { accesses.push(`set-prop:${String(prop)}`); return true; },
  });
  try {
    const { drawer, animaticHost } = makeDrawer(api);
    takes.AnimaticTakes({ document: fakeDocument, api, drawer, host: animaticHost });
    drawer.open('gens');
    await tick();
    assert.equal(findAll(animaticHost, 'animatic-take-card').length, 1, 'restore works');
    const animaticTouches = accesses.filter((a) => a.includes('raindesk'));
    assert.equal(animaticTouches.length, 0, `animatic restore must not touch localStorage (${accesses.join(',')})`);
  } finally {
    global.localStorage = savedLS;
  }
});
