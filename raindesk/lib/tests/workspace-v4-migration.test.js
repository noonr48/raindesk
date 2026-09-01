'use strict';

/*
 * Adapter-family A1 — v3→v4 migration hardening discriminators (Round-6 §6):
 * every clause here fails on the pre-A1 seed: invalid edges retained as dock
 * presentations, maximised rows floated, duplicate memberships landing in two
 * canonical groups, and no .pre-v4.bak evidence trail.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-v4-migration-'));
process.env.RAINDESK_DATA_DIR = scratch;

const hostileV3 = {
  schemaVersion: 3,
  revision: 21,
  viewport: { x: 0, y: 0, zoom: 1 },
  activeWindowId: 'w_max',
  windows: [
    { windowId: 'w_max', type: 'note', space: 'world', entityRef: 'note:max', x: 10, y: 20, width: 300, height: 200, rotation: 0, scale: 1, zIndex: 5, state: 'maximised', groupId: null, collapsed: false, pinned: false, locked: false, dock: null },
    { windowId: 'w_badedge', type: 'layers_panel', space: 'screen', entityRef: 'layers:main', x: 0, y: 0, width: 300, height: 400, rotation: 0, scale: 1, zIndex: 3, state: 'docked', groupId: null, collapsed: false, pinned: false, locked: false, dock: 'diagonal' },
    { windowId: 'w_shelf_badedge', type: 'note', space: 'screen', entityRef: 'note:shelf', x: 40, y: 40, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 4, state: 'minimised', groupId: 'g_two', collapsed: true, pinned: false, locked: false, dock: 'spiral' },
    { windowId: 'w_dup', type: 'note', space: 'world', entityRef: 'note:dup', x: 100, y: 100, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 2, state: 'floating', groupId: 'g_first', collapsed: false, pinned: false, locked: false, dock: null },
    { windowId: 'w_only', type: 'note', space: 'world', entityRef: 'note:only', x: 500, y: 500, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 2, state: 'floating', groupId: 'g_ghost', collapsed: false, pinned: false, locked: false, dock: null },
  ],
  // duplicate membership: w_dup lives in BOTH g_first and g_second (stored order wins);
  // g_ghost loses its only member to the dedupe (w_only claimed by nothing else —
  // it is listed only here, so g_ghost KEEPS it; the dissolution case is g_second
  // losing w_dup when w_shelf_badedge is already shelf-excluded).
  groups: [
    { groupId: 'g_first', windowIds: ['w_dup'], activeWindowId: 'w_dup' },
    { groupId: 'g_second', windowIds: ['w_dup', 'w_shelf_badedge'], activeWindowId: 'w_dup' },
    { groupId: 'g_ghost', windowIds: ['w_only'], activeWindowId: 'w_only' },
  ],
  shelf: { windowIds: ['w_shelf_badedge'] },
};
fs.writeFileSync(path.join(scratch, 'workspace.json'), JSON.stringify(hostileV3));
const v3Bytes = fs.readFileSync(path.join(scratch, 'workspace.json'));

const v4 = require('../../lib/workspace-v4');
const doc = v4.read();

test('A1: invalid dock edges convert to floating in ONE reconciliation pass', () => {
  const badEdge = doc.windows.find((w) => w.ref.windowId === 'w_badedge');
  assert.equal(badEdge.presentation.kind, 'floating', 'docked row with an invalid edge floats (never a {docked, edge:"diagonal"} presentation)');
  const shelfBad = doc.windows.find((w) => w.ref.windowId === 'w_shelf_badedge');
  assert.equal(shelfBad.presentation.kind, 'floating', 'shelf row with an invalid retained edge floats');
  assert.ok(doc.shelf.members.some((m) => m.windowId === 'w_shelf_badedge'), 'the shelf row itself stays on the shelf');
});

test('A1: maximised rows keep the maximised presentation with the v3 rect as fallback', () => {
  const max = doc.windows.find((w) => w.ref.windowId === 'w_max');
  assert.equal(max.presentation.kind, 'maximised', 'maximised v3 state converts to the typed maximised presentation');
  assert.equal(max.spatial.x, 10, 'the v3 rect survives as the floating fallback (unmaximise lands here)');
  assert.equal(max.beforeMaximise, null, 'v3 never stored the prior presentation — the fallback is implicit floating');
});

test('A1 BOUNDARY: the v3 reader sanitizes duplicate membership BEFORE the migration sees it — the seed dedupe is defense-in-depth', () => {
  const v3read = require('../../lib/workspace').read();
  const seen = JSON.stringify(v3read.groups.map((g) => [g.groupId, g.windowIds]));
  assert.ok(!seen.includes('"w_dup","w_dup"'), `the v3 store never surfaces a duplicate to the migration (reader output: ${seen})`);
  assert.equal(v3read.groups.filter((g) => g.groupId === 'g_second').length, 0, 'the all-duplicate group is dropped by the reader itself');
  // Consequently the seeded doc carries an empty receipt here — the dedupe
  // discriminator lives in workspace-v4-migration-dedupe.test.js, which
  // injects the hostile v3 past the reader (require-cache stub).
  assert.equal(doc.migration.repairedDuplicateMemberships.length, 0, 'no repair was needed — the reader already deduped');
});

test('A1: the exact .pre-v4.bak backup exists with the original v3 bytes', () => {
  const backup = path.join(scratch, 'workspace.json.pre-v4.bak');
  assert.ok(fs.existsSync(backup), 'the backup was written before the atomic replacement');
  assert.ok(fs.readFileSync(backup).equals(v3Bytes), 'the backup carries the EXACT original v3 bytes');
});

test('A1: generations and collapsed-guard semantics survive the hardened seed', () => {
  for (const w of doc.windows) {
    assert.equal(w.ref.generation, 1, 'every live v3 row births at generation 1');
    assert.ok(w.ref.incarnationId, 'every row carries a persisted incarnation id');
  }
  const shelfBad = doc.windows.find((w) => w.ref.windowId === 'w_shelf_badedge');
  assert.equal(shelfBad.collapsed, false, 'minimisation-derived collapsed:true never becomes the user-collapse flag');
});
