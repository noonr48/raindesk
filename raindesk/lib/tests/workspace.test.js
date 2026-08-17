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
  workspace.upsertObject({ id: 'references', type: 'reference_board', x: 1260, y: 200, collapsed: true });
  const ws = workspace.read();
  assert.equal(ws.objects.length, 2);
  assert.equal(ws.objects[0].rotation, -2);
  assert.equal(ws.objects[1].collapsed, true);
});

test('workspace move/dock/focus actions return executable inverses across world + screen objects', () => {
  const moved = workspace.applyAction({ type: 'move_panel', targetId: 'character_mara', payload: { x: 1000, y: 260, width: 500 } });
  assert.equal(moved.object.x, 1000);
  assert.equal(moved.inverse.payload.x, 800);
  workspace.upsertObject({ id: 'screen_partner', type: 'partner_panel', space: 'screen', x: 900, y: 80, width: 300, height: 500 });
  const docked = workspace.applyAction({ type: 'dock_panel', targetId: 'screen_partner', payload: { dock: 'right' } });
  assert.equal(docked.object.dock, 'right');
  workspace.applyAction(docked.inverse);
  assert.equal(workspace.read().objects.find((o) => o.id === 'screen_partner').dock, null);
  const focus = workspace.applyAction({ type: 'focus', targetId: 'references' });
  assert.equal(focus.workspace.activeObjectId, 'references');
});

test('move action inverse restores a pre-existing dock instead of only old coordinates', () => {
  workspace.upsertObject({ id: 'dock_restore', type: 'partner_panel', x: 900, y: 80, width: 300, height: 500, dock: 'right' });
  const moved = workspace.applyAction({ type: 'move_panel', targetId: 'dock_restore', payload: { x: 500, y: 180 } });
  assert.equal(moved.object.dock, null);
  assert.equal(moved.inverse.payload.dock, 'right');
  workspace.applyAction(moved.inverse);
  const restored = workspace.read().objects.find((o) => o.id === 'dock_restore');
  assert.equal(restored.x, 900);
  assert.equal(restored.y, 80);
  assert.equal(restored.dock, 'right');
});

test('workspace schema v1 migrates existing utility panels to screen space and creative canvases to world space', () => {
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
  assert.equal(ws.schemaVersion, 2);
  assert.equal(ws.objects.find((o) => o.id === 'old_partner').space, 'screen');
  assert.equal(ws.objects.find((o) => o.id === 'old_character').space, 'world');
  assert.equal(ws.viewport.zoom, 0.75);
});

test('world objects never inherit screen-edge docking', () => {
  const obj = workspace.upsertObject({ id: 'world_ref', type: 'reference_board', space: 'world', x: 10, y: 20, dock: 'right' });
  assert.equal(obj.space, 'world');
  assert.equal(obj.dock, null);
  assert.throws(() => workspace.applyAction({ type: 'dock_panel', targetId: 'world_ref', payload: { dock: 'left' } }), /world objects/);
});
