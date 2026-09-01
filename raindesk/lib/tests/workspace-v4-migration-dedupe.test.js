'use strict';

/*
 * Adapter-family A1 — duplicate-membership dedupe discriminator. The v3
 * READER sanitizes duplicates before the migration boundary, so this test
 * injects the hostile v3 PAST the reader (require-cache stub) to prove the
 * seed's own defense-in-depth: stored-order dedupe + the repair receipt.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-v4-dedupe-'));
process.env.RAINDESK_DATA_DIR = scratch;

const hostileV3 = {
  schemaVersion: 3,
  revision: 7,
  viewport: { x: 0, y: 0, zoom: 1 },
  activeWindowId: 'w_a',
  windows: [
    { windowId: 'w_a', type: 'note', space: 'world', x: 0, y: 0, width: 100, height: 80, zIndex: 1, state: 'floating', collapsed: false, pinned: false, locked: false, dock: null },
    { windowId: 'w_b', type: 'note', space: 'world', x: 200, y: 0, width: 100, height: 80, zIndex: 2, state: 'floating', collapsed: false, pinned: false, locked: false, dock: null },
  ],
  groups: [
    { groupId: 'g_keep', windowIds: ['w_a'], activeWindowId: 'w_a' },
    { groupId: 'g_lose', windowIds: ['w_a', 'w_b'], activeWindowId: 'w_b' },
  ],
  shelf: { windowIds: [] },
};

// Stub the v3 module BEFORE the first v4 touch: seedFromV3's
// require('./workspace') must receive the RAW hostile store.
const v3Path = require.resolve('../../lib/workspace');
require.cache[v3Path] = { id: v3Path, filename: v3Path, loaded: true, exports: { read: () => hostileV3 } };

const v4 = require('../../lib/workspace-v4');
const doc = v4.read();

test('A1 dedupe: stored group order wins; the removal is a migration-repair receipt', () => {
  const ids = doc.groups.map((g) => g.groupId);
  assert.ok(ids.includes('g_keep'), 'the FIRST stored group survives');
 assert.ok(ids.includes('g_lose'), 'the loser group SURVIVES — it still owns its non-duplicate member (partial dedupe, not group death)');
  const keep = doc.groups.find((g) => g.groupId === 'g_keep');
  assert.deepEqual(keep.members.map((m) => m.windowId), ['w_a'], 'the duplicate lives in exactly ONE canonical group (the keeper)');
  const lose = doc.groups.find((g) => g.groupId === 'g_lose');
  assert.deepEqual(lose.members.map((m) => m.windowId), ['w_b'], 'the loser kept ONLY its non-duplicate member — w_a was removed');
  const receipt = doc.migration.repairedDuplicateMemberships.find((r) => r.windowId === 'w_a');
  assert.ok(receipt, 'the removal is recorded — never silent');
  assert.equal(receipt.keptBy, 'g_keep', 'the receipt names the keeper');
  assert.equal(receipt.removedFrom, 'g_lose', 'the receipt names the loser');
});
