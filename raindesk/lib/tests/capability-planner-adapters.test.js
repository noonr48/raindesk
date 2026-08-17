'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../capability-planner');
const adapters = require('../production-adapters');

test('default registry upgrades bounded image capability through the real registered adapter', () => {
  const plan = planner.plan(['local_refinement'], {
    context: { shotId: 'S01', selection: { type: 'lasso', region: { x: 1, y: 1, width: 10, height: 10 } } },
  });
  const image = plan.stages.find((stage) => stage.capabilityId === 'local_image_take');
  assert.equal(image.capabilityState, 'review_take');
  assert.equal(image.adapter.id, 'bounded_image_region_v1');
  assert.equal(image.adapter.invocationBoundary, 'surface');
  assert.equal(image.executor, null, 'surface adapter is not mislabeled as a server executor');
  assert.equal(Object.prototype.hasOwnProperty.call(image.adapter, 'implementationRef'), false, 'internal implementation reference stays out of Partner plan');
});

test('without a registered adapter local image work falls back to planning-only', () => {
  const registry = adapters.createRegistry();
  const plan = planner.plan(['local_refinement'], {
    adapterRegistry: registry,
    context: { shotId: 'S01', selection: { type: 'lasso', region: { x: 1, y: 1, width: 10, height: 10 } } },
  });
  const image = plan.stages.find((stage) => stage.capabilityId === 'local_image_take');
  assert.equal(image.state, 'planning_only');
  assert.equal(image.adapter, null);
  assert.ok(plan.blockedBy.some((item) => item.kind === 'adapter' && item.key === 'local_image_take'));
});

test('registering a server pose adapter upgrades only pose capability and still requires review', () => {
  const registry = adapters.createRegistry([{
    id: 'pose_control_v1', capabilityId: 'pose_blocking', availability: 'available', invocationBoundary: 'server',
    priority: 100, creativeMutation: true, reviewRequired: true, requiredEvidence: ['shot_scope'],
    inputContract: ['shot_id', 'movement_packet'], outputContract: ['pose_candidate'],
  }]);
  const plan = planner.plan(['character_motion'], {
    permissionMode: 'act', adapterRegistry: registry, context: { shotId: 'S02' },
  });
  const pose = plan.stages.find((stage) => stage.capabilityId === 'pose_blocking');
  assert.equal(pose.capabilityState, 'review_take');
  assert.equal(pose.state, 'review_take');
  assert.equal(pose.executor, 'pose_control_v1');
  assert.equal(pose.adapter.id, 'pose_control_v1');
  assert.equal(pose.disposition, 'proposal', 'creative production remains review-gated in Act mode');
  assert.equal(plan.reviewRequired, true);
});

test('adapter-required evidence joins recipe evidence instead of replacing it', () => {
  const registry = adapters.createRegistry([{
    id: 'camera_tool_v1', capabilityId: 'camera_previs', availability: 'available', invocationBoundary: 'external',
    creativeMutation: true, reviewRequired: true, requiredEvidence: ['character_presence'],
  }]);
  const plan = planner.plan(['camera_reveal'], { adapterRegistry: registry, context: { shotId: 'S03' } });
  const camera = plan.stages.find((stage) => stage.capabilityId === 'camera_previs');
  assert.deepEqual(camera.requiredEvidence.sort(), ['character_presence', 'end_frame', 'shot_scope', 'start_frame'].sort());
  assert.deepEqual(camera.missingEvidence.sort(), ['character_presence', 'end_frame', 'start_frame'].sort());
  assert.equal(camera.state, 'needs_evidence');
});

test('model recipe request alone cannot upgrade a capability when registry has no adapter', () => {
  const plan = planner.plan([{ id: 'performance_closeup', reason: 'partner interpretation' }], {
    adapterRegistry: adapters.createRegistry(), context: { shotId: 'S04' },
  });
  const performance = plan.stages.find((stage) => stage.capabilityId === 'performance_motion');
  assert.equal(performance.state, 'planning_only');
  assert.equal(performance.executor, null);
});
