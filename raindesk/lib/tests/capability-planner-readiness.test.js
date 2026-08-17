'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../workflow-router');
const core = require('../capability-planner-core');
const planner = require('../capability-planner');

const HAND_EDIT_CONTEXT = {
  shotId: 'S09',
  selection: { type: 'lasso', lasso: [[10, 10], [60, 10], [60, 60], [10, 60]] },
};

test('router hygiene keeps a right-hand-only edit out of camera and performance recipes', () => {
  const intent = {
    raw: 'only change the right hand, keep everything else',
    interpretation: { kind: 'edit', editScope: 'right hand only', preserve: ['face identity', 'framing'] },
  };
  const ranked = router.rankRecipes(intent).map((recipe) => recipe.id);
  assert.ok(ranked.includes('local_refinement'));
  assert.ok(!ranked.includes('camera_reveal'), `camera_reveal leaked in: ${ranked.join(',')}`);
  assert.ok(!ranked.includes('performance_closeup'), `performance_closeup leaked in: ${ranked.join(',')}`);
});

test('mixed plan is ready for production while still reporting adapter blockers', () => {
  const plan = core.plan(
    ['local_refinement', 'camera_reveal', 'performance_closeup'],
    { context: HAND_EDIT_CONTEXT, permissionMode: 'suggest' },
  );
  assert.equal(plan.status, 'ready');
  assert.equal(plan.hasExecutableProductionStage, true);
  assert.equal(plan.preparatoryOnly, false);
  const blockedCapabilities = plan.blockedBy.filter((item) => item.kind === 'adapter').map((item) => item.key);
  assert.ok(blockedCapabilities.includes('camera_previs'));
  assert.ok(blockedCapabilities.includes('performance_motion'));
});

test('preparatory-only kickstart plan is ready without an executable production stage', () => {
  const plan = core.plan(['creative_kickstart'], { context: {}, permissionMode: 'suggest' });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.preparatoryOnly, true);
  assert.equal(plan.hasExecutableProductionStage, false);
});

test('adapter-aware facade reports identical readiness fields to core', () => {
  const workflows = ['local_refinement', 'camera_reveal', 'performance_closeup'];
  const options = { context: HAND_EDIT_CONTEXT, permissionMode: 'suggest' };
  const base = core.plan(workflows, options);
  const enriched = planner.plan(workflows, options);
  assert.equal(enriched.status, base.status);
  assert.equal(enriched.hasExecutableProductionStage, base.hasExecutableProductionStage);
  assert.equal(enriched.preparatoryOnly, base.preparatoryOnly);
});
