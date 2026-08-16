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
  assert.equal(workspace.read().objects.find((o) => o.id === 'refs_panel').x, 880);
  assert.ok(done.inverse);
  const accepted = actions.accept(proposal.id);
  assert.equal(accepted.status, 'accepted');
  actions.revert(proposal.id);
  assert.equal(workspace.read().objects.find((o) => o.id === 'refs_panel').x, 20);
});
