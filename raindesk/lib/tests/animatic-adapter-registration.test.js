'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const planner = require('../capability-planner');
const adapters = require('../production-adapters');
const invocations = require('../adapter-invocations');

function runtimeEnv(patch = {}) {
  return {
    RAINDESK_ANIMATIC_EXECUTOR: process.execPath,
    RAINDESK_ANIMATIC_PROJECT_ROOT: os.tmpdir(),
    RAINDESK_SOURCE_RIGHTS: 'owner-controlled project artwork',
    ...patch,
  };
}

test('animatic capability fails closed when no complete executor runtime is explicitly configured', () => {
  for (const env of [
    {},
    { RAINDESK_ANIMATIC_EXECUTOR: process.execPath },
    runtimeEnv({ RAINDESK_SOURCE_RIGHTS: '' }),
    runtimeEnv({ RAINDESK_ANIMATIC_EXECUTOR: 'python animatic_compile.py' }),
    runtimeEnv({ RAINDESK_ANIMATIC_PROJECT_ROOT: 'relative/project-root' }),
  ]) {
    const registry = adapters.createDefaultRegistry(env);
    const plan = planner.plan(['animatic_pass'], { adapterRegistry: registry, context: { shotId: 'S03' } });
    const stage = plan.stages.find((item) => item.capabilityId === 'animatic_timing');
    assert.equal(stage.state, 'planning_only');
    assert.equal(stage.adapter, null);
    assert.equal(registry.resolve('animatic_timing'), null);
  }
});

test('configured video-skill runtime registers the v0.2 animatic contract without leaking its executable', () => {
  const env = runtimeEnv();
  const runtime = adapters.configuredAnimaticRuntime(env);
  assert.ok(runtime);
  assert.equal(runtime.executable, process.execPath);
  assert.equal(runtime.projectRoot, os.tmpdir());

  const registry = adapters.createDefaultRegistry(env);
  const descriptor = registry.resolve('animatic_timing');
  assert.equal(descriptor.id, 'animatic_timing_v1');
  assert.equal(descriptor.invocationBoundary, 'external');
  assert.equal(descriptor.reviewRequired, true);
  assert.equal(descriptor.creativeMutation, true);
  assert.ok(descriptor.inputContract.includes('SequenceSourceSnapshot@0.2.0'));
  assert.ok(descriptor.outputContract.includes('SequenceCandidateManifest@0.2.0'));
  assert.equal(Object.prototype.hasOwnProperty.call(descriptor, 'implementationRef'), false);
  assert.equal(registry.getImplementationRef('animatic_timing_v1'), `exec:${process.execPath}`);
});

test('configured animatic capability becomes a review take and Act mode still cannot auto-accept it', () => {
  const registry = adapters.createDefaultRegistry(runtimeEnv());
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
