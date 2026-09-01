'use strict';

/*
 * Adapter-family A4 — Partner identity receipts (Round-6 §5): receipts and
 * inverses carry the exact WindowRef, and a revert against a closed-then-
 * reopened window fails INCARNATION_REPLACED — the new incarnation is never
 * moved by the old one's inverse.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-partner-identity-'));
process.env.RAINDESK_DATA_DIR = scratch;

const workspaceV4 = require('../../lib/workspace-v4');
const actions = require('../../lib/partner-actions');

const inc = () => `inc_${Math.random().toString(36).slice(2, 14)}`;

test.before(() => {
  const created = workspaceV4.applyIntent({ actorId: 'a4_test', intentId: 'a4_create_1', op: { kind: 'window.create', windowId: 'window_a4x', incarnationId: inc(), type: 'note', x: 10, y: 10, width: 200, height: 150 } });
  return created;
});

test('A4: receipts and inverses carry the exact WindowRef', () => {
  const proposal = actions.recordProposal({ type: 'dock_panel', targetId: 'window_a4x', payload: { dock: 'left' } }, { permissionMode: 'act' });
  assert.equal(proposal.status, 'approved', 'act mode auto-approves executable types');
  const done = actions.execute(proposal.id);
  assert.equal(done.status, 'completed');
  assert.ok(done.receipt && done.receipt.kind === 'workspace-v4', 'receipt recorded on the v4 lane');
  assert.ok(done.receipt.ref && done.receipt.ref.windowId === 'window_a4x' && Number.isInteger(done.receipt.ref.generation) && typeof done.receipt.ref.incarnationId === 'string', 'the receipt carries a FULL WindowRef');
  assert.ok(done.inverse && done.inverse.ref && done.inverse.ref.incarnationId === done.receipt.ref.incarnationId, 'the inverse carries the SAME incarnation ref');
  assert.equal(workspaceV4.read().windows.find((w) => w.ref.windowId === 'window_a4x').presentation.kind, 'docked', 'the dock landed');
});

test('A4: revert after close+reopen fails INCARNATION_REPLACED — the new incarnation is never moved', () => {
  const before = workspaceV4.read().windows.find((w) => w.ref.windowId === 'window_a4x');
  assert.equal(before.presentation.kind, 'docked', 'PRECONDITION: the original incarnation is docked');

  // close + intentional reopen: a NEW incarnation owns the id now
  workspaceV4.applyIntent({ actorId: 'a4_test', intentId: 'a4_close_1', op: { kind: 'window.close', window: { ...before.ref } } });
  const reopened = workspaceV4.applyIntent({ actorId: 'a4_test', intentId: 'a4_create_2', op: { kind: 'window.create', windowId: 'window_a4x', incarnationId: inc(), type: 'note', x: 500, y: 400, width: 200, height: 150 } });
  const newRef = reopened.changed.windows[0].ref;
  assert.notEqual(newRef.incarnationId, before.ref.incarnationId, 'the reopen minted a NEW incarnation');
  assert.equal(workspaceV4.read().windows.find((w) => w.ref.windowId === 'window_a4x').presentation.kind, 'floating', 'the new incarnation starts floating');

  // the revert must fail typed, never docking the new incarnation
  const list = actions.list();
  const completed = list.find((a) => a.status === 'completed' && a.targetId === 'window_a4x');
  assert.ok(completed, 'the dock action is still revertable');
  assert.throws(() => actions.revert(completed.id), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /revert failed/);
    assert.match(e.message, /INCARNATION_REPLACED/, 'the typed code surfaces through the revert wrapper');
    return true;
  }, 'revert against the reopened window throws');

  const after = workspaceV4.read().windows.find((w) => w.ref.windowId === 'window_a4x');
  assert.equal(after.ref.incarnationId, newRef.incarnationId, 'the NEW incarnation still owns the id');
  assert.equal(after.presentation.kind, 'floating', 'the new incarnation was NOT moved by the old inverse (still floating, never docked)');
  assert.equal(after.spatial.x, 500, 'the new incarnation keeps its own geometry');
});
