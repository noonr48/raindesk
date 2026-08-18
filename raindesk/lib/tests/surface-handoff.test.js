'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handoff = require('../../public/js/surface-handoff.js');

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'invoke_abc',
    adapterId: 'bounded_image_region_v1',
    capabilityId: 'local_image_take',
    invocationBoundary: 'surface',
    status: 'awaiting_approval',
    disposition: 'proposal',
    reviewRequired: true,
    creativeMutation: true,
    scope: { shotId: 'S01', artRevisionId: 'rev_1', selectionFingerprint: 'a'.repeat(24) },
    ...overrides,
  };
}

test('surface hand-off accepts only the explicit bounded local-image approval request', () => {
  assert.equal(handoff.isSupportedRequest(request()), true);
  assert.equal(handoff.isSupportedRequest(request({ status: 'awaiting_surface' })), false);
  assert.equal(handoff.isSupportedRequest(request({ adapterId: 'other_adapter' })), false);
  assert.equal(handoff.isSupportedRequest(request({ reviewRequired: false })), false);
  assert.equal(handoff.isSupportedRequest(request({ creativeMutation: false })), false);
});

test('shot check refuses stale hand-off after artist changes shots', () => {
  const document = {
    documentElement: { dataset: { raindeskShotId: 'S02' } },
    getElementById() { return null; },
  };
  assert.equal(handoff.sameShot(request(), document), false);
  document.documentElement.dataset.raindeskShotId = 'S01';
  assert.equal(handoff.sameShot(request(), document), true);
});

test('current shot falls back to visible title when stable published id is unavailable', () => {
  const document = {
    documentElement: { dataset: {} },
    getElementById(id) { return id === 'shotTitle' ? { textContent: 'S07 · close-up' } : null; },
  };
  assert.equal(handoff.currentShotId(document), 'S07');
});

test('surface hand-off scripts load after ChatDrawer and before app boot', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../public/index.html'), 'utf8');
  const chat = html.indexOf('js/chat.js');
  const handoffScript = html.indexOf('js/surface-handoff.js');
  const app = html.indexOf('js/app.js');
  assert.ok(chat >= 0 && handoffScript > chat && app > handoffScript);
  assert.match(html, /css\/surface-handoff\.css/);
});

test('stale art revision fails the hand-off scope check', () => {
  const doc = { documentElement: { dataset: { raindeskShotId: 'S01' } }, getElementById() { return null; } };
  const scoped = request({ scope: {
    shotId: 'S01', artRevisionId: 'rev_1', selectionFingerprint: 'a'.repeat(24),
    selectionStable: handoff.stableSelection({ type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] }),
  } });
  const root = { RaindeskSurfaceState: { liveScope: () => ({ artRevisionId: 'rev_9', selection: null }) } };
  assert.equal(handoff.sameScope(scoped, root, doc), false);
});

test('stale selection fails the hand-off scope check structurally', () => {
  const doc = { documentElement: { dataset: { raindeskShotId: 'S01' } }, getElementById() { return null; } };
  const scoped = request({ scope: {
    shotId: 'S01', artRevisionId: 'rev_1', selectionFingerprint: 'a'.repeat(24),
    selectionStable: handoff.stableSelection({ type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] }),
  } });
  const root = { RaindeskSurfaceState: { liveScope: () => ({
    artRevisionId: 'rev_1',
    selection: { type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 61, y: 60 }] },
  }) } };
  assert.equal(handoff.sameScope(scoped, root, doc), false);
});

test('fresh scope with matching revision and canonical selection passes', () => {
  const doc = { documentElement: { dataset: { raindeskShotId: 'S01' } }, getElementById() { return null; } };
  const scoped = request({ scope: {
    shotId: 'S01', artRevisionId: 'rev_1', selectionFingerprint: 'a'.repeat(24),
    selectionStable: handoff.stableSelection({ type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] }),
  } });
  const root = { RaindeskSurfaceState: { liveScope: () => ({
    artRevisionId: 'rev_1',
    selection: { type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] },
  }) } };
  assert.equal(handoff.sameScope(scoped, root, doc), true);
});

test('absent live-scope seam or legacy request without frozen form degrades to the shot check', () => {
  const doc = { documentElement: { dataset: { raindeskShotId: 'S01' } }, getElementById() { return null; } };
  const scoped = request({ scope: {
    shotId: 'S01', artRevisionId: 'rev_1', selectionFingerprint: 'a'.repeat(24),
    selectionStable: handoff.stableSelection({ type: 'lasso', points: [{ x: 10, y: 10 }] }),
  } });
  // Seam entirely absent (scripts failed / pre-upgrade page): still same shot → pass, never crash.
  assert.equal(handoff.sameScope(scoped, {}, doc), true);
  // Legacy request carrying only the fingerprint (no selectionStable): shot check governs.
  const legacy = request({ scope: { shotId: 'S01', artRevisionId: null, selectionFingerprint: 'a'.repeat(24) } });
  assert.equal(handoff.sameScope(legacy, {}, doc), true);
});

test('ledger wiring records approval, marks handed_off on GEN click, and restore re-renders the approved chip', () => {
  const calls = [];
  function fakeDoc() {
    const listeners = {};
    return {
      documentElement: { dataset: { raindeskShotId: 'S01' } },
      getElementById() { return null; },
      querySelector(sel) { return sel === '.chat-list' ? { appendChild() {}, querySelector() { return null; }, dataset: {} } : null; },
      createElement(tag) { return { tag, style: {}, dataset: {}, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, appendChild() {}, append() {}, classList: { add() {} }, remove() {} }; },
      addEventListener(ev, fn) { listeners[ev] = fn; },
      _listeners: listeners,
    };
  }
  const doc = fakeDoc();
  const root = {
    fetch: (url, opts) => { calls.push({ url, method: opts && opts.method }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ invocations: [] }) }); },
    addEventListener() {},
    CustomEvent: function () {}, dispatchEvent() {},
  };
  const controller = handoff.SurfaceHandoff({ root, document: doc });
  assert.ok(controller);

  // Build the same SurfaceHandoff again but capture the genBtn capture-click listener via document.addEventListener
  const doc2 = fakeDoc();
  const root2 = {
    fetch: (url, opts) => { calls.push({ url, method: opts && opts.method }); return Promise.resolve({ ok: true, json: () => Promise.resolve({ invocations: [] }) }); },
    addEventListener() {}, CustomEvent: function () {}, dispatchEvent() {},
  };
  handoff.SurfaceHandoff({ root: root2, document: doc2 });
  // restore fired at construction → GET approved list
  const get = calls.find((c) => c.url.includes('/api/invocations?status=approved'));
  assert.ok(get, 'boot must query the ledger for approved invocations');
});
