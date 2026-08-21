'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-workspace-'));
process.env.RAINDESK_DATA_DIR = scratch;
const workspace = require('../../lib/workspace');

test('workspace persists stable world transforms and floating/minimised state', () => {
  workspace.upsertObject({ id: 'character_mara', type: 'character_canvas', entityRef: 'character:mara', x: 800, y: 120, width: 420, height: 560, rotation: -2 });
  workspace.upsertObject({ id: 'references', type: 'reference_board', entityRef: 'board:references', x: 1260, y: 200, collapsed: true });
  const ws = workspace.read();
  assert.equal(ws.schemaVersion, 3);
  assert.equal(ws.windows.length, 2);
  const mara = ws.windows.find((w) => w.windowId === 'character_mara');
  const refs = ws.windows.find((w) => w.windowId === 'references');
  assert.equal(mara.rotation, -2);
  assert.equal(refs.collapsed, true);
  assert.equal(mara.state, 'floating');
  assert.equal(mara.entityRef, 'character:mara');
});

test('workspace move/dock/focus actions return executable inverses across world + screen objects', () => {
  const moved = workspace.applyAction({ type: 'move_panel', targetId: 'character_mara', payload: { x: 1000, y: 260, width: 500 } });
  assert.equal(moved.object.x, 1000);
  assert.equal(moved.inverse.payload.x, 800);
  workspace.upsertObject({ id: 'screen_partner', type: 'partner_panel', entityRef: 'partner:main', x: 900, y: 80, width: 300, height: 500 });
  const docked = workspace.applyAction({ type: 'dock_panel', targetId: 'screen_partner', payload: { dock: 'right' } });
  assert.equal(docked.object.dock, 'right');
  assert.equal(workspace.read().windows.find((w) => w.windowId === 'screen_partner').state, 'docked');
  workspace.applyAction(docked.inverse);
  assert.equal(workspace.read().windows.find((w) => w.windowId === 'screen_partner').dock, null);
  const focus = workspace.applyAction({ type: 'focus', targetId: 'references' });
  assert.equal(focus.workspace.activeWindowId, 'references');
});

test('move action inverse restores a pre-existing dock instead of only old coordinates', () => {
  workspace.upsertObject({ id: 'dock_restore', type: 'partner_panel', entityRef: 'partner:restore', x: 900, y: 80, width: 300, height: 500, dock: 'right' });
  const moved = workspace.applyAction({ type: 'move_panel', targetId: 'dock_restore', payload: { x: 500, y: 180 } });
  assert.equal(moved.object.dock, null);
  assert.equal(moved.inverse.payload.dock, 'right');
  workspace.applyAction(moved.inverse);
  const restored = workspace.read().windows.find((w) => w.windowId === 'dock_restore');
  assert.equal(restored.x, 900);
  assert.equal(restored.y, 80);
  assert.equal(restored.dock, 'right');
});

test('close/open panel cycles map onto v3 states with shelf membership', () => {
  workspace.upsertObject({ id: 'screen_layers', type: 'layers_panel', entityRef: 'layers:main', x: 40, y: 80, width: 300, height: 400 });
  workspace.applyAction({ type: 'close_panel', targetId: 'screen_layers' });
  let ws = workspace.read();
  assert.equal(ws.windows.find((w) => w.windowId === 'screen_layers').state, 'minimised');
  assert.ok(ws.shelf.windowIds.includes('screen_layers'), 'minimised screen window joins the shelf');
  workspace.applyAction({ type: 'open_panel', targetId: 'screen_layers' });
  ws = workspace.read();
  assert.equal(ws.windows.find((w) => w.windowId === 'screen_layers').state, 'floating');
  assert.equal(ws.shelf.windowIds.includes('screen_layers'), false, 'open removes it from the shelf');
});

test('workspace schema v1 migrates through the chain to v3 preserving spaces and viewport', () => {
  fs.writeFileSync(workspace.WORKSPACE_PATH, JSON.stringify({
    schemaVersion: 1,
    viewport: { x: 12, y: -8, zoom: 0.75 },
    activeObjectId: null,
    objects: [
      { id: 'old_partner', type: 'partner_panel', x: 10, y: 20, width: 300, height: 400 },
      { id: 'old_character', type: 'character_canvas', x: 800, y: 50, width: 420, height: 560 },
    ],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }), 'utf8');
  const ws = workspace.read();
  assert.equal(ws.schemaVersion, 3);
  assert.equal(ws.windows.find((w) => w.windowId === 'old_partner').space, 'screen');
  assert.equal(ws.windows.find((w) => w.windowId === 'old_character').space, 'world');
  assert.equal(ws.viewport.zoom, 0.75);
  assert.ok(fs.existsSync(`${workspace.WORKSPACE_PATH}.pre-v3.bak`), 'migration leaves a pre-v3 backup of the original file');
});

test('v2 workspace migrates to v3: hidden world sheets become tabbed, hidden screen panels minimised, groupIds synthesize groups', () => {
  fs.writeFileSync(workspace.WORKSPACE_PATH, JSON.stringify({
    schemaVersion: 2,
    viewport: { x: 0, y: 0, zoom: 1 },
    activeObjectId: 'active_panel',
    objects: [
      { id: 'sheet_a', type: 'sheet', space: 'world', entityRef: 'sheet:a', x: 0, y: 0, width: 400, height: 300, visible: false, collapsed: true, zIndex: 3 },
      { id: 'panel_util', type: 'layers_panel', space: 'screen', x: 10, y: 10, width: 300, height: 200, visible: false, collapsed: true, zIndex: 4 },
      { id: 'panel_docked', type: 'partner_panel', space: 'screen', x: 900, y: 0, width: 300, height: 500, visible: true, dock: 'right', zIndex: 5 },
      { id: 'win_g1', type: 'note', space: 'world', entityRef: 'note:g1', x: 5, y: 5, width: 200, height: 150, groupId: 'grp1', zIndex: 6 },
      { id: 'win_g2', type: 'note', space: 'world', entityRef: 'note:g2', x: 250, y: 5, width: 200, height: 150, groupId: 'grp1', zIndex: 7 },
      { id: 'active_panel', type: 'generic_panel', space: 'screen', x: 0, y: 0, width: 200, height: 100, zIndex: 8 },
    ],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }), 'utf8');
  const ws = workspace.read();
  assert.equal(ws.schemaVersion, 3);
  assert.equal(ws.windows.find((w) => w.windowId === 'sheet_a').state, 'tabbed');
  assert.equal(ws.windows.find((w) => w.windowId === 'panel_util').state, 'minimised');
  assert.deepEqual(ws.shelf.windowIds, ['panel_util']);
  assert.equal(ws.windows.find((w) => w.windowId === 'panel_docked').state, 'docked');
  const grp = ws.groups.find((g) => g.groupId === 'grp1');
  assert.deepEqual(grp.windowIds, ['win_g1', 'win_g2']);
  assert.equal(ws.activeWindowId, 'active_panel');
  assert.equal(ws.revision, 1);
});

test('structural writes are revision-gated: stale baseRevision fails 409 with current state', () => {
  const ws = workspace.read();
  workspace.upsertWindow({ windowId: 'rev_probe', type: 'note', entityRef: 'note:rev', x: 0, y: 0, width: 200, height: 150 });
  let stale = null;
  try { workspace.setShelf(['rev_probe'], { baseRevision: ws.revision }); } catch (e) { stale = e; }
  assert.ok(stale && stale.status === 409, 'stale baseRevision is rejected with 409');
  assert.ok(stale.workspace && Array.isArray(stale.workspace.windows), '409 carries the current workspace state');
  // Fresh revision is accepted and bumps the counter.
  const fresh = workspace.read();
  const next = workspace.setShelf(['rev_probe'], { baseRevision: fresh.revision });
  assert.equal(next.revision, fresh.revision + 1);
});

test('validation rejects unknown structural fields, bad refs, and dangling referential integrity', () => {
  assert.throws(() => workspace.upsertWindow({ windowId: 'bad_field', type: 'note', x: 0, y: 0, width: 100, height: 100, surprise: true }), /unsupported field/);
  assert.throws(() => workspace.upsertWindow({ windowId: 'bad_ref', type: 'note', entityRef: 'not-typed', x: 0, y: 0, width: 100, height: 100 }), /typed reference/);
  assert.throws(() => workspace.upsertWindow({ windowId: 'bad_state', type: 'note', state: 'levitating', x: 0, y: 0, width: 100, height: 100 }), /floating\|tabbed\|docked\|minimised\|maximised/);
  workspace.upsertWindow({ windowId: 'grp_only', type: 'note', entityRef: 'note:only', x: 0, y: 0, width: 100, height: 100 });
  assert.throws(() => workspace.setGroups([{ groupId: 'ghost', windowIds: ['no_such_window'] }]), /unknown window/);
  assert.throws(() => workspace.setShelf(['no_such_window']), /unknown window/);
});

test('v3 window API round-trips groups, shelf and delete cascades', () => {
  workspace.upsertWindow({ windowId: 'w_alpha', type: 'note', entityRef: 'note:alpha', x: 0, y: 0, width: 200, height: 150 });
  workspace.upsertWindow({ windowId: 'w_beta', type: 'note', entityRef: 'note:beta', x: 250, y: 0, width: 200, height: 150 });
  workspace.setGroups([{ groupId: 'g_ab', windowIds: ['w_alpha', 'w_beta'], activeWindowId: 'w_beta' }]);
  let ws = workspace.read();
  assert.equal(ws.windows.find((w) => w.windowId === 'w_alpha').groupId, 'g_ab');
  assert.equal(ws.groups[0].activeWindowId, 'w_beta');
  // Deleting ONE member keeps the group with the survivor; deleting the last dissolves it.
  workspace.deleteWindow('w_beta');
  ws = workspace.read();
  assert.equal(ws.groups.length, 1, 'group survives the loss of one member');
  assert.deepEqual(ws.groups[0].windowIds, ['w_alpha']);
  assert.equal(ws.windows.find((w) => w.windowId === 'w_alpha').groupId, 'g_ab');
  workspace.deleteWindow('w_alpha');
  ws = workspace.read();
  assert.equal(ws.groups.length, 0, 'group dissolves when the last member leaves');
  assert.equal(ws.activeWindowId === 'w_beta', false, 'active window cannot dangle after delete');
});

test('legacy object projection keeps pre-v3 clients functional', () => {
  workspace.upsertObject({ id: 'legacy_probe', type: 'reference_board', entityRef: 'board:legacy', x: 10, y: 20, width: 320, height: 260 });
  workspace.upsertObject({ id: 'legacy_probe', visible: false });
  const client = workspace.readClient();
  const legacy = client.objects.find((o) => o.id === 'legacy_probe');
  assert.ok(legacy, 'client envelope exposes objects[] with ids');
  assert.equal(legacy.visible, false);
  assert.equal(legacy.state, 'tabbed', 'world put-away maps to the tabbed state');
});

test('world objects never inherit screen-edge docking', () => {
  const obj = workspace.upsertObject({ id: 'world_ref', type: 'reference_board', space: 'world', entityRef: 'board:world', x: 10, y: 20, dock: 'right' });
  assert.equal(obj.space, 'world');
  assert.equal(obj.dock, null);
  assert.throws(() => workspace.applyAction({ type: 'dock_panel', targetId: 'world_ref', payload: { dock: 'left' } }), /world objects/);
});
