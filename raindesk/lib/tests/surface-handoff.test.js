'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const handoff = require('../../public/js/surface-handoff.js');

function selection() {
  return { type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 60, y: 60 }] };
}

function request(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'invoke_abc',
    turnId: 'turn_surface_1',
    stageId: 'local_refinement:2:local_image_take',
    recipeId: 'local_refinement',
    adapterId: 'bounded_image_region_v1',
    capabilityId: 'local_image_take',
    invocationBoundary: 'surface',
    status: 'awaiting_approval',
    disposition: 'proposal',
    reviewRequired: true,
    creativeMutation: true,
    scope: {
      shotId: 'S01', artRevisionId: 'rev_1', selectionFingerprint: 'a'.repeat(24),
      selectionStable: handoff.stableSelection(selection()),
    },
    requiredEvidence: ['shot_scope', 'edit_region'],
    requiredInputs: ['shot_id', 'base_revision_id'],
    expectedOutputs: ['candidate_take'],
    preserves: ['accepted_artwork_until_commit'],
    sideEffects: ['creates_candidate_take'],
    ...overrides,
  };
}

function docFor(shotId = 'S01') {
  return { documentElement: { dataset: { raindeskShotId: shotId } }, getElementById() { return null; } };
}

test('surface hand-off accepts only explicit bounded local-image approval requests', () => {
  assert.equal(handoff.isSupportedRequest(request()), true);
  assert.equal(handoff.isSupportedRequest(request({ status: 'awaiting_surface' })), false);
  assert.equal(handoff.isSupportedRequest(request({ adapterId: 'other_adapter' })), false);
  assert.equal(handoff.isSupportedRequest(request({ reviewRequired: false })), false);
  assert.equal(handoff.isSupportedRequest(request({ creativeMutation: false })), false);
});

test('shot check refuses stale hand-off after artist changes shots', () => {
  const document = docFor('S02');
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
  const root = { RaindeskSurfaceState: { liveScope: () => ({ artRevisionId: 'rev_9', selection: selection() }) } };
  assert.equal(handoff.sameScope(request(), root, docFor()), false);
});

test('stale selection fails the hand-off scope check structurally', () => {
  const root = { RaindeskSurfaceState: { liveScope: () => ({
    artRevisionId: 'rev_1',
    selection: { type: 'lasso', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 61, y: 60 }] },
  }) } };
  assert.equal(handoff.sameScope(request(), root, docFor()), false);
});

test('fresh scope with matching revision and canonical selection passes', () => {
  const root = { RaindeskSurfaceState: { liveScope: () => ({ artRevisionId: 'rev_1', selection: selection() }) } };
  assert.equal(handoff.sameScope(request(), root, docFor()), true);
});

test('missing live proof fails closed for frozen revision/selection and incomplete legacy fingerprints', () => {
  assert.equal(handoff.sameScope(request(), {}, docFor()), false, 'missing live seam cannot prove a frozen scope');
  const noLiveRevision = { RaindeskSurfaceState: { liveScope: () => ({ artRevisionId: null, selection: selection() }) } };
  assert.equal(handoff.sameScope(request(), noLiveRevision, docFor()), false);
  const noLiveSelection = { RaindeskSurfaceState: { liveScope: () => ({ artRevisionId: 'rev_1', selection: null }) } };
  assert.equal(handoff.sameScope(request(), noLiveSelection, docFor()), false);

  const legacy = request({ scope: { shotId: 'S01', artRevisionId: null, selectionFingerprint: 'a'.repeat(24) } });
  assert.equal(handoff.sameScope(legacy, {}, docFor()), false, 'a fingerprint without canonical frozen selection cannot be restored');
  const shotOnly = request({ scope: { shotId: 'S01', artRevisionId: null, selectionFingerprint: null, selectionStable: null } });
  assert.equal(handoff.sameScope(shotOnly, {}, docFor()), true, 'scope with no frozen revision/selection still reduces to exact shot identity');
});

test('approval record preserves the bounded request instead of collapsing it to a shot id', () => {
  const original = request();
  const record = handoff.approvalRecord(original);
  assert.equal(record.status, 'approved');
  assert.equal(record.supersede, true);
  assert.equal(record.stageId, original.stageId);
  assert.equal(record.recipeId, original.recipeId);
  assert.equal(record.invocationBoundary, 'surface');
  assert.equal(record.scope.artRevisionId, 'rev_1');
  assert.deepEqual(record.scope.selectionStable, original.scope.selectionStable);
  assert.deepEqual(record.requiredInputs, original.requiredInputs);
  assert.deepEqual(record.preserves, original.preserves);
});

test('reload reconstruction requires v2 authority and retains exact frozen scope', () => {
  const approved = handoff.approvalRecord(request());
  delete approved.supersede;
  approved.schemaVersion = 2;
  const restored = handoff.requestFromLedger(approved);
  assert.ok(restored);
  assert.equal(restored.status, 'awaiting_approval');
  assert.deepEqual(restored.scope, request().scope);
  assert.deepEqual(restored.expectedOutputs, ['candidate_take']);

  assert.equal(handoff.requestFromLedger({
    id: 'legacy', adapterId: 'bounded_image_region_v1', capabilityId: 'local_image_take',
    shotId: 'S01', status: 'approved', scope: null,
  }), null, 'v1 approval without recorded scope cannot gain authority on reload');
});

test('SurfaceHandoff boot queries durable approved ledger without making it a permission source', () => {
  const calls = [];
  const listeners = {};
  const document = {
    documentElement: { dataset: { raindeskShotId: 'S01' } },
    getElementById() { return null; },
    querySelector(sel) { return sel === '.chat-list' ? { appendChild() {}, querySelector() { return null; }, dataset: {} } : null; },
    createElement(tag) {
      return {
        tag, style: {}, dataset: {}, listeners: {},
        addEventListener(ev, fn) { this.listeners[ev] = fn; },
        appendChild() {}, append() {}, classList: { add() {} }, remove() {},
      };
    },
    addEventListener(ev, fn) { listeners[ev] = fn; },
  };
  const root = {
    fetch: (url, opts) => {
      calls.push({ url, method: opts && opts.method, body: opts && opts.body });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ invocations: [] }) });
    },
    addEventListener() {}, CustomEvent: function () {}, dispatchEvent() {},
  };
  const controller = handoff.SurfaceHandoff({ root, document });
  assert.ok(controller);
  assert.ok(calls.find((c) => c.url.includes('/api/invocations?status=approved')), 'boot queries approved history');
});
