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

test('workspace move/dock/focus actions return executable inverses', () => {
  const moved = workspace.applyAction({ type: 'move_panel', targetId: 'character_mara', payload: { x: 1000, y: 260, width: 500 } });
  assert.equal(moved.object.x, 1000);
  assert.equal(moved.inverse.payload.x, 800);
  const docked = workspace.applyAction({ type: 'dock_panel', targetId: 'character_mara', payload: { dock: 'right' } });
  assert.equal(docked.object.dock, 'right');
  workspace.applyAction(docked.inverse);
  assert.equal(workspace.read().objects.find((o) => o.id === 'character_mara').dock, null);
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
