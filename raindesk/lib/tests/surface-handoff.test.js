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
