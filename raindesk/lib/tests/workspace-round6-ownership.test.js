'use strict';

/*
 * GPT Pro round-6 discriminators — canonical ownership of freeform windows:
 * every live window belongs to AT MOST ONE group, and never simultaneously
 * to a group and the shelf. Legacy boards written by older builds may carry
 * contradictory rows; normalization converges them deterministically at the
 * read boundary (shelf wins, first stored group claims duplicates) instead
 * of rejecting whole boards, and the tightened validator then makes the
 * malformed combination unwritable through any structural route.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-workspace-round6-'));
process.env.RAINDESK_DATA_DIR = scratch;
const workspace = require('../../lib/workspace');

function seedStore(doc) {
  fs.writeFileSync(path.join(scratch, 'workspace.json'), JSON.stringify(doc));
}

test('multi-group claims and group-shelf overlap converge on read (shelf wins, first group keeps duplicates)', () => {
  seedStore({
    schemaVersion: 3,
    revision: 21,
    viewport: { x: 0, y: 0, zoom: 1 },
    activeWindowId: null,
    windows: [
      { windowId: 'win_a', type: 'note', space: 'world', entityRef: 'note:a', x: 0, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 1, state: 'floating', groupId: 'g_b_second', collapsed: false, pinned: false, locked: false, dock: null },
      { windowId: 'win_b', type: 'note', space: 'world', entityRef: 'note:b', x: 250, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 2, state: 'floating', groupId: null, collapsed: false, pinned: false, locked: false, dock: null },
      { windowId: 'win_c', type: 'note', space: 'world', entityRef: 'note:c', x: 500, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 3, state: 'floating', groupId: 'g_c', collapsed: false, pinned: false, locked: false, dock: null },
    ],
    groups: [
      { groupId: 'g_ab_first', windowIds: ['win_a', 'win_b'], activeWindowId: 'win_a' },
      { groupId: 'g_b_second', windowIds: ['win_b'], activeWindowId: 'win_b' },
      { groupId: 'g_c', windowIds: ['win_c'], activeWindowId: 'win_c' },
    ],
    shelf: { windowIds: ['win_c'] },
  });
  const out = workspace.read();
  const gAB = out.groups.find((g) => g.groupId === 'g_ab_first');
  assert.deepEqual(gAB && [...gAB.windowIds].sort(), ['win_a', 'win_b'], 'first stored group keeps both members');
  assert.equal(gAB.activeWindowId, 'win_a', 'still-valid active member survives normalization');
  assert.equal(out.groups.find((g) => g.groupId === 'g_b_second'), undefined, 'duplicate claim emptied and dissolved the second group');
  assert.equal(out.groups.find((g) => g.groupId === 'g_c'), undefined, 'the shelf removed its window from the group server-side');
  assert.equal(out.windows.find((w) => w.windowId === 'win_a').groupId, 'g_ab_first');
  assert.equal(out.windows.find((w) => w.windowId === 'win_b').groupId, 'g_ab_first');
  assert.equal(out.windows.find((w) => w.windowId === 'win_c').groupId, null, 'a shelved ref carries no reverse pointer');
});

test('contradictory ownership injected through an upsert cannot survive validation', () => {
  seedStore({
    schemaVersion: 3,
    revision: 30,
    viewport: { x: 0, y: 0, zoom: 1 },
    activeWindowId: null,
    windows: [
      { windowId: 'solo', type: 'note', space: 'world', entityRef: 'note:solo', x: 0, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 1, state: 'floating', groupId: null, collapsed: false, pinned: false, locked: false, dock: null },
    ],
    groups: [],
    shelf: { windowIds: [] },
  });
  const cleanRevision = workspace.read().revision;
  // A stale writer pushes a reverse pointer naming a group that does not
  // exist; ownership derives from the canonical collections instead.
  const row = workspace.upsertWindow({ windowId: 'solo', type: 'note', entityRef: 'note:solo', x: 5, y: 5, width: 200, height: 150, groupId: 'ghost_g' });
  const out = workspace.read();
  assert.equal(row.groupId, null, 'the returned clone mirrors the normalized stored row');
  assert.equal(out.windows.find((w) => w.windowId === 'solo').groupId, null);
  assert.equal(out.revision, cleanRevision + 1, 'the write still lands and bumps the revision');
});

test('setShelf is the atomic ownership transaction: shelved refs leave their group', () => {
  seedStore({
    schemaVersion: 3,
    revision: 40,
    viewport: { x: 0, y: 0, zoom: 1 },
    activeWindowId: null,
    windows: [
      { windowId: 'w_left', type: 'note', space: 'world', entityRef: 'note:left', x: 0, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 1, state: 'tabbed', groupId: 'g_pair', collapsed: false, pinned: false, locked: false, dock: null },
      { windowId: 'w_right', type: 'note', space: 'world', entityRef: 'note:right', x: 250, y: 0, width: 200, height: 150, rotation: 0, scale: 1, zIndex: 2, state: 'tabbed', groupId: 'g_pair', collapsed: false, pinned: false, locked: false, dock: null },
    ],
    groups: [{ groupId: 'g_pair', windowIds: ['w_left', 'w_right'], activeWindowId: 'w_right' }],
    shelf: { windowIds: [] },
  });
  const base = workspace.read();
  const out = workspace.setShelf(['w_left'], { baseRevision: base.revision });
  assert.deepEqual(out.shelf.windowIds, ['w_left']);
  assert.equal(out.windows.find((w) => w.windowId === 'w_left').state, 'minimised', 'shelving still minimises the member');
  const pair = out.groups.find((g) => g.groupId === 'g_pair');
  assert.ok(pair, 'the surviving member keeps the group alive');
  assert.deepEqual(pair.windowIds, ['w_right'], 'the shelved ref left the group atomically');
  assert.equal(pair.activeWindowId, 'w_right', 'active falls to the surviving member');
  assert.equal(out.windows.find((w) => w.windowId === 'w_left').groupId, null, 'reverse pointer cleaned server-side');
});
