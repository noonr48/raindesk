'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../capability-planner');
const invocations = require('../adapter-invocations');
const adapters = require('../production-adapters');

function readyLocalPlan(permissionMode = 'suggest') {
  return planner.plan(['local_refinement'], {
    permissionMode,
    context: { shotId: 'S01', selection: { type: 'lasso', region: { x: 10, y: 20, width: 100, height: 80 } } },
  });
}

test('ready review-take produces one bounded surface hand-off request', () => {
  const requests = invocations.requestsForPlan(readyLocalPlan('suggest'), { turnId: 'turn_123' });
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.adapterId, 'bounded_image_region_v1');
  assert.equal(request.capabilityId, 'local_image_take');
  assert.equal(request.invocationBoundary, 'surface');
  assert.equal(request.disposition, 'proposal');
  assert.equal(request.status, 'awaiting_approval');
  assert.equal(request.reviewRequired, true);
  assert.ok(request.requiredInputs.includes('region_png'));
  assert.ok(request.requiredInputs.includes('mask_png'));
  assert.ok(request.expectedOutputs.includes('candidate_take'));
  assert.equal(Object.prototype.hasOwnProperty.call(request, 'implementationRef'), false);
});

test('request identity is deterministic for one turn and stage', () => {
  const plan = readyLocalPlan('suggest');
  const a = invocations.requestsForPlan(plan, { turnId: 'turn_same' });
  const b = invocations.requestsForPlan(plan, { turnId: 'turn_same' });
  assert.equal(a[0].id, b[0].id);
  assert.notEqual(a[0].id, invocations.requestsForPlan(plan, { turnId: 'turn_other' })[0].id);
});

test('Watch mode emits no actionable adapter requests', () => {
  assert.deepEqual(invocations.requestsForPlan(readyLocalPlan('watch'), { turnId: 'turn_watch' }), []);
});

test('missing evidence and planning-only stages emit no invocation request', () => {
  const missingRegion = planner.plan(['local_refinement'], { context: { shotId: 'S01' } });
  assert.deepEqual(invocations.requestsForPlan(missingRegion, { turnId: 'turn_missing' }), []);
  const motion = planner.plan(['character_motion'], { context: { shotId: 'S02' } });
  assert.deepEqual(invocations.requestsForPlan(motion, { turnId: 'turn_motion' }), []);
});

test('forged or mismatched adapter identity is rejected', () => {
  const plan = readyLocalPlan('suggest');
  const stage = plan.stages.find((item) => item.capabilityId === 'local_image_take');
  const forged = { ...stage, adapter: { ...stage.adapter, id: 'missing_adapter' } };
  assert.equal(invocations.stageRequest(forged, { turnId: 'turn_forged' }), null);

  const registry = adapters.createRegistry([{
    id: 'wrong_capability_v1', capabilityId: 'pose_blocking', availability: 'available', invocationBoundary: 'server',
    creativeMutation: true, reviewRequired: true,
  }]);
  const mismatch = { ...stage, adapter: { id: 'wrong_capability_v1', capabilityId: 'local_image_take' } };
  assert.equal(invocations.stageRequest(mismatch, { turnId: 'turn_mismatch', registry }), null);
});

test('auto server request can become server-ready only for a stage the planner marked auto', () => {
  const registry = adapters.createRegistry([{
    id: 'safe_server_v1', capabilityId: 'local_image_take', availability: 'available', invocationBoundary: 'server',
    creativeMutation: false, reviewRequired: false, requiredEvidence: ['shot_scope', 'edit_region'],
  }]);
  const stage = {
    id: 'synthetic:1:local_image_take', recipeId: 'synthetic', capabilityId: 'local_image_take',
    state: 'operational', disposition: 'auto', requiredEvidence: ['shot_scope', 'edit_region'], missingEvidence: [],
    adapter: { id: 'safe_server_v1', capabilityId: 'local_image_take' },
  };
  const request = invocations.stageRequest(stage, { turnId: 'turn_server', registry });
  assert.equal(request.status, 'ready_server');
  assert.equal(request.reviewRequired, false);
});
