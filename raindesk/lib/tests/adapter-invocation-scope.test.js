'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const invocations = require('../adapter-invocations');
const planner = require('../capability-planner');

test('invocation scope snapshots shot, revision and exact selection identity', () => {
  const context = {
    shotId: 'S01', artRevisionId: 'rev_12',
    selection: { type: 'lasso', points: [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 50 }] },
  };
  const scope = invocations.scopeSnapshot(context);
  assert.equal(scope.shotId, 'S01');
  assert.equal(scope.artRevisionId, 'rev_12');
  assert.match(scope.selectionFingerprint, /^[a-f0-9]{24}$/);
  assert.equal(scope.selectionFingerprint, invocations.scopeSnapshot(context).selectionFingerprint);
  assert.deepEqual(scope.selectionStable, { type: 'lasso', points: [{ x: 10, y: 20 }, { x: 40, y: 20 }, { x: 40, y: 50 }] });
});

test('selection fingerprint changes when the lasso changes', () => {
  const a = invocations.selectionFingerprint({ type: 'lasso', points: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  const b = invocations.selectionFingerprint({ type: 'lasso', points: [{ x: 1, y: 2 }, { x: 3, y: 5 }] });
  assert.notEqual(a, b);
});

test('ready invocation request carries the approval-time scope snapshot', () => {
  const context = {
    shotId: 'S03', artRevisionId: 'rev_xyz',
    selection: { type: 'lasso', points: [{ x: 5, y: 5 }, { x: 90, y: 5 }, { x: 90, y: 90 }] },
  };
  const plan = planner.plan(['local_refinement'], { context });
  const request = invocations.requestsForPlan(plan, { turnId: 'turn_scope', context })[0];
  assert.ok(request);
  assert.equal(request.scope.shotId, 'S03');
  assert.equal(request.scope.artRevisionId, 'rev_xyz');
  assert.equal(request.scope.selectionFingerprint, invocations.selectionFingerprint(context.selection));
});
