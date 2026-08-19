'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../capability-planner');
const adapters = require('../production-adapters');
const invocations = require('../adapter-invocations');

test('animatic capability fails closed when no executor is explicitly configured', () => {
  const registry = adapters.createDefaultRegistry({});
  const plan = planner.plan(['animatic_pass'], {
    adapterRegistry: registry,
    context: { shotId: 'S03' },
  });
  const stage = plan.stages.find((item) => item.capabilityId === 'animatic_timing');
  assert.equal(stage.state, 'planning_only');
  assert.equal(stage.adapter, null);
  assert.equal(registry.resolve('animatic_timing'), null);
  assert.ok(plan.blockedBy.some((item) => item.kind === 'adapter' && item.key === 'animatic_timing'));
});

test('configured video-skill executor registers the v0.2 animatic contract without leaking its command', () => {
  const registry = adapters.createDefaultRegistry({ RAINDESK_ANIMATIC_EXECUTOR: '/opt/video/creative-contracts/tools/animatic_compile.py' });
  const descriptor = registry.resolve('animatic_timing');

  assert.equal(descriptor.id, 'animatic_timing_v1');
  assert.equal(descriptor.invocationBoundary, 'external');
  assert.equal(descriptor.reviewRequired, true);
  assert.equal(descriptor.creativeMutation, true);
  assert.ok(descriptor.inputContract.includes('SequenceSourceSnapshot@0.2.0'));
  assert.ok(descriptor.outputContract.includes('SequenceCandidateManifest@0.2.0'));
  assert.equal(Object.prototype.hasOwnProperty.call(descriptor, 'implementationRef'), false);
  assert.equal(
    registry.getImplementationRef('animatic_timing_v1'),
    'command:/opt/video/creative-contracts/tools/animatic_compile.py',
  );
});

test('configured animatic capability becomes a review take and Act mode still cannot auto-accept it', () => {
  const registry = adapters.createDefaultRegistry({ RAINDESK_ANIMATIC_EXECUTOR: '/opt/video/creative-contracts/tools/animatic_compile.py' });
  const plan = planner.plan(['animatic_pass'], {
    permissionMode: 'act',
    adapterRegistry: registry,
    context: { shotId: 'S03' },
  });
  const stage = plan.stages.find((item) => item.capabilityId === 'animatic_timing');

  assert.equal(stage.capabilityState, 'review_take');
  assert.equal(stage.state, 'review_take');
  assert.equal(stage.adapter.id, 'animatic_timing_v1');
  assert.equal(stage.executor, null, 'external adapter is not mislabeled as an in-process server executor');
  assert.equal(stage.disposition, 'proposal');
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.hasExecutableProductionStage, true);

  const requests = invocations.requestsForPlan(plan, {
    turnId: 'turn_animatic_1',
    registry,
    context: { shotId: 'S03', artRevisionId: 'artrev_7' },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].adapterId, 'animatic_timing_v1');
  assert.equal(requests[0].status, 'awaiting_approval');
  assert.equal(requests[0].reviewRequired, true);
  assert.ok(requests[0].requiredInputs.includes('SequenceSourceSnapshot@0.2.0'));
});
