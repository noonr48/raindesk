'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-actions-'));
process.env.RAINDESK_DATA_DIR = scratch;
const workspace = require('../../lib/workspace');
const actions = require('../../lib/partner-actions');

workspace.upsertObject({ id: 'refs_panel', type: 'reference_board', x: 20, y: 30, width: 300, height: 200 });

test('Watch/Suggest/Act are enforced by action ledger rather than trusted to model output', () => {
  const watch = actions.recordProposal({ type: 'move_panel', targetId: 'refs_panel', payload: { x: 500 } }, { permissionMode: 'watch' });
  assert.equal(watch.status, 'advisory');
  assert.throws(() => actions.approve(watch.id), (e) => e.status === 409);

  const suggest = actions.recordProposal({ type: 'move_panel', targetId: 'refs_panel', payload: { x: 500 } }, { permissionMode: 'suggest' });
  assert.equal(suggest.status, 'proposed');
  assert.equal(actions.approve(suggest.id).status, 'approved');

  const actSafe = actions.recordProposal({ type: 'move_panel', targetId: 'refs_panel', payload: { x: 600 } }, { permissionMode: 'act' });
  assert.equal(actSafe.status, 'approved');
  const actContent = actions.recordProposal({ type: 'create_variant', targetId: 'shot_1' }, { permissionMode: 'act' });
  assert.equal(actContent.status, 'proposed', 'creative content remains reviewable even in Act');
});

test('approved spatial action executes through bounded workspace API and can be reverted', () => {
  const proposal = actions.recordProposal({ type: 'move_panel', targetId: 'refs_panel', payload: { x: 880, y: 120 } }, { permissionMode: 'suggest' });
  actions.approve(proposal.id);
  const done = actions.execute(proposal.id);
  assert.equal(done.status, 'completed');
  assert.equal(workspace.read().windows.find((w) => w.windowId === 'refs_panel').x, 880);
  assert.ok(done.inverse);
  const accepted = actions.accept(proposal.id);
  assert.equal(accepted.status, 'accepted');
  actions.revert(proposal.id);
  assert.equal(workspace.read().windows.find((w) => w.windowId === 'refs_panel').x, 20);
});

/* ---------------- v4 routing (STAGE-1 design: WindowRef receipts/inverses) */

const workspaceV4 = require('../../lib/workspace-v4');

test('partner v4 path: window_* targets execute through the intent protocol with ref-bearing receipts and inverses', () => {
  const made = workspaceV4.applyIntent({ actorId: 'test_v4partner', intentId: 'p_create', op: { kind: 'window.create', windowId: 'window_notes', incarnationId: 'inc_pnotes_0001', type: 'notes_panel', x: 10, y: 20, width: 300, height: 220 } });
  const ref = made.changed.windows[0].ref;
  const proposal = actions.recordProposal({ type: 'move_panel', targetId: 'window_notes', payload: { x: 640, y: 120 } }, { permissionMode: 'suggest' });
  actions.approve(proposal.id);
  const done = actions.execute(proposal.id);
  assert.equal(done.status, 'completed');
  assert.equal(done.receipt.kind, 'workspace-v4');
  assert.deepEqual(done.receipt.ref, ref, 'receipt stores the exact WindowRef');
  assert.ok(done.inverse && done.inverse.ref, 'inverse stores the exact WindowRef');
  assert.equal(workspaceV4.readV4().windows.find((w) => w.ref.windowId === 'window_notes').spatial.x, 640, 'moved through the v4 spatial lane');
  actions.revert(proposal.id);
  assert.equal(workspaceV4.readV4().windows.find((w) => w.ref.windowId === 'window_notes').spatial.x, 10, 'revert restored the pre-move geometry through the same ref');
});

test('partner v4 revert of a closed-and-reopened window fails identity-exact: never moves the new incarnation', () => {
  workspaceV4.applyIntent({ actorId: 'test_v4partner', intentId: 'q_create', op: { kind: 'window.create', windowId: 'window_probe', incarnationId: 'inc_pprobe_0001', type: 'generic_panel', x: 100, y: 100, width: 300, height: 200 } });
  const proposal = actions.recordProposal({ type: 'move_panel', targetId: 'window_probe', payload: { x: 900 } }, { permissionMode: 'suggest' });
  actions.approve(proposal.id);
  actions.execute(proposal.id);
  // close the moved incarnation, then intentionally reopen (NEW generation)
  const moved = workspaceV4.readV4().windows.find((w) => w.ref.windowId === 'window_probe');
  workspaceV4.applyIntent({ actorId: 'test_v4partner', intentId: 'q_close', op: { kind: 'window.close', window: moved.ref } });
  workspaceV4.applyIntent({ actorId: 'test_v4partner', intentId: 'q_reopen', op: { kind: 'window.create', windowId: 'window_probe', incarnationId: 'inc_pprobe_0002', type: 'generic_panel', x: 50, y: 50, width: 300, height: 200 } });
  assert.throws(() => actions.revert(proposal.id), (e) => e.status === 409 && /INCARNATION_REPLACED|WINDOW_GENERATION_GONE/.test(e.message),
    'revert fails identity-exact instead of moving the new incarnation');
  const fresh = workspaceV4.readV4().windows.find((w) => w.ref.windowId === 'window_probe');
  assert.equal(fresh.spatial.x, 50, 'the new incarnation is untouched');
  assert.equal(fresh.ref.generation, 2);
});

test('partner v4 dock_panel on a world-flagged window_* desk surface succeeds (Stage-2 spec-review clause-7 repair)', () => {
  // Birth-flagged freeform surfaces carry space:'world' (world-unit
  // geometry) and dock BY DESIGN — the stale v3-thinking space guard
  // blocked exactly this legitimate case.
  workspaceV4.applyIntent({ actorId: 'test_v4partner', intentId: 'dockflag_create', op: { kind: 'window.create', windowId: 'window_scenes', incarnationId: 'inc_dockflag_0001', type: 'sequence_strip', space: 'world', x: 40, y: 40, width: 300, height: 220 } });
  const proposal = actions.recordProposal({ type: 'dock_panel', targetId: 'window_scenes', payload: { dock: 'left' } }, { permissionMode: 'act' });
  const done = actions.execute(proposal.id);
  assert.equal(done.status, 'completed', 'world-flagged desk windows partner-dock through the typed presentation');
  const row = workspaceV4.readV4().windows.find((w) => w.ref.windowId === 'window_scenes');
  assert.equal(row.presentation.kind, 'docked');
  assert.equal(row.presentation.edge, 'left');
  assert.equal(row.space, 'world', 'geometry authority untouched: docking is a presentation, never a coordinate rewrite');
});
