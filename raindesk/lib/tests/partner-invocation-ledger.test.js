'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-invocation-ledger-'));
process.env.RAINDESK_DATA_DIR = scratch;

const ledger = require('../partner-invocation-ledger');

function invocation(overrides = {}) {
  return {
    id: 'invoke_abc123',
    requestId: 'invoke_abc123',
    turnId: 'turn_1',
    shotId: 'S01',
    adapterId: 'bounded_image_region_v1',
    capabilityId: 'local_image_take',
    status: 'proposed',
    ...overrides,
  };
}

test('record is idempotent by id and survives a fresh read (reload restore)', () => {
  const first = ledger.record(invocation());
  assert.equal(first.created, true);
  const second = ledger.record(invocation({ status: 'approved' })); // same id — no-op
  assert.equal(second.created, false);
  assert.equal(second.entry.status, 'proposed');
  const pending = ledger.pendingForShot('S01');
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, 'invoke_abc123');
});

test('approval status stamps approvedAt and is durable across reads', () => {
  const entry = ledger.setStatus('invoke_abc123', 'approved');
  assert.equal(entry.status, 'approved');
  assert.ok(entry.approvedAt);
  const pending = ledger.pendingForShot('S01');
  assert.equal(pending.length, 1); // approved still pending until handed off
  assert.equal(pending[0].status, 'approved');
});

test('a newer same-shot request marks prior pending invocations stale', () => {
  ledger.record(invocation({ id: 'invoke_new456', requestId: 'invoke_new456', turnId: 'turn_2' }));
  const marked = ledger.markStaleSuperseded({ shotId: 'S01', requestId: 'invoke_new456' });
  assert.equal(marked, 1); // only invoke_abc123 was pending before
  const stale = ledger.find(ledger.read(), 'invoke_abc123');
  assert.equal(stale.status, 'stale');
  assert.ok(stale.staleAt);
  const stillPending = ledger.pendingForShot('S01');
  assert.equal(stillPending.length, 1);
  assert.equal(stillPending[0].id, 'invoke_new456');
});

test('approved handed_off removes from pending; cancelled removes from pending; other shots untouched', () => {
  ledger.setStatus('invoke_new456', 'approved');
  ledger.setStatus('invoke_new456', 'handed_off');
  assert.equal(ledger.pendingForShot('S01').length, 0);
  ledger.record(invocation({ id: 'invoke_s02', shotId: 'S02' }));
  ledger.markStaleSuperseded({ shotId: 'S01', requestId: 'invoke_none' }); // different shot
  const s02 = ledger.pendingForShot('S02');
  assert.equal(s02.length, 1);
  assert.equal(s02[0].status, 'proposed');
  ledger.setStatus('invoke_s02', 'cancelled');
  assert.equal(ledger.pendingForShot('S02').length, 0);
});

test('list filters by shot and status; ledger rejects corrupt entries early', () => {
  const rows = ledger.list({ shotId: 'S01' });
  assert.ok(rows.length >= 2);
  const staleOnly = ledger.list({ shotId: 'S01', status: 'stale' });
  assert.equal(staleOnly.length, 1);
  assert.throws(() => ledger.record({ no: 'id' }), /invocation id is required/);
  // Overlong ids are truncated by the text(96) normalizer, not rejected:
  const long = ledger.record(invocation({ id: 'x'.repeat(200) }));
  assert.equal(long.entry.id.length, 96);
});
