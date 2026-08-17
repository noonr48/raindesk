'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const planner = require('../capability-planner');

test('empty workflow produces an idle execution plan', () => {
  const plan = planner.plan([]);
  assert.equal(plan.status, 'idle');
  assert.equal(plan.canProceed, false);
  assert.deepEqual(plan.stages, []);
});

test('bounded local refinement refuses to infer an edit region', () => {
  const plan = planner.plan([{ id: 'local_refinement' }], {
    context: { shotId: 'S01', selection: { type: 'direction_annotation', rawText: 'move hand' } },
  });
  const image = plan.stages.find((stage) => stage.capabilityId === 'local_image_take');
  assert.equal(image.capabilityState, 'review_take');
  assert.equal(image.state, 'needs_evidence');
  assert.equal(image.disposition, 'blocked');
  assert.deepEqual(image.missingEvidence, ['edit_region']);
  assert.equal(plan.status, 'needs_evidence');
  assert.equal(plan.reviewRequired, true);
  assert.ok(plan.blockedBy.some((item) => item.kind === 'evidence' && item.key === 'edit_region'));
});

test('Act mode still treats bounded image generation as a review proposal', () => {
  const plan = planner.plan(['local_refinement'], {
    permissionMode: 'act',
    context: { shotId: 'S01', selection: { type: 'lasso', lasso: [[10, 10], [40, 10], [40, 40]] } },
  });
  const image = plan.stages.find((stage) => stage.capabilityId === 'local_image_take');
  assert.equal(image.state, 'review_take');
  assert.equal(image.disposition, 'proposal');
  assert.equal(plan.status, 'ready');
  assert.equal(plan.permissionMode, 'act');
  assert.equal(plan.reviewRequired, true);
  assert.ok(plan.availableStages.includes(image.id));
  assert.ok(plan.reviewableStages.includes(image.id));
  assert.equal(plan.autoExecutable.includes(image.id), false);
});

test('Watch mode never converts capability availability into execution permission', () => {
  const plan = planner.plan(['local_refinement'], {
    permissionMode: 'watch',
    context: { shotId: 'S01', selection: { type: 'lasso', region: { x: 10, y: 10, width: 50, height: 50 } } },
  });
  assert.equal(plan.status, 'ready');
  assert.equal(plan.canProceed, false);
  assert.deepEqual(plan.autoExecutable, []);
  assert.ok(plan.stages.filter((stage) => ['operational', 'review_take'].includes(stage.state)).every((stage) => stage.disposition === 'advisory'));
  assert.ok(plan.blockedBy.some((item) => item.kind === 'permission' && item.key === 'watch'));
});

test('camera recipe stays planning-only when no camera production adapter exists', () => {
  const plan = planner.plan(['camera_reveal'], { context: { shotId: 'S03' } });
  const camera = plan.stages.find((stage) => stage.capabilityId === 'camera_previs');
  assert.equal(camera.state, 'planning_only');
  assert.equal(camera.disposition, 'blocked');
  assert.deepEqual(camera.missingEvidence, ['start_frame', 'end_frame']);
  assert.equal(plan.status, 'planning_only');
  assert.ok(plan.blockedBy.some((item) => item.kind === 'adapter' && item.key === 'camera_previs'));
  assert.ok(plan.blockedBy.some((item) => item.kind === 'evidence' && item.key === 'start_frame'));
});

test('contact choreography records multi-character evidence but does not invent geometry executors', () => {
  const plan = planner.plan(['contact_action'], {
    context: {
      shotId: 'S08',
      characterAnchors: {
        characters: [
          { id: 'a', locked: true, anchors: [{ sha: 'a'.repeat(64) }] },
          { id: 'b', locked: false, anchors: [] },
        ],
      },
    },
  });
  assert.equal(plan.evidence.multiple_characters, true);
  assert.equal(plan.evidence.locked_identity, true);
  const contact = plan.stages.find((stage) => stage.capabilityId === 'contact_geometry');
  assert.equal(contact.state, 'planning_only');
  assert.deepEqual(contact.missingEvidence, []);
  assert.equal(contact.executor, null);
});

test('Act mode auto-executes only explicitly safe preparation capabilities', () => {
  const plan = planner.plan(['creative_kickstart'], { permissionMode: 'act' });
  const ids = plan.autoExecutable.map((stageId) => stageId.split(':').at(-1));
  assert.deepEqual(ids, ['direction_packet', 'workspace_arrangement']);
});

test('capability registry stays model/node agnostic and distinguishes current execution states', () => {
  assert.equal(planner.getCapability('local_image_take').state, 'review_take');
  assert.equal(planner.getCapability('pose_blocking').state, 'planning_only');
  assert.equal(planner.getCapability('visual_inspection').state, 'unavailable');
  assert.doesNotMatch(JSON.stringify(planner.CAPABILITIES), /ComfyUI|ControlNet|SDXL|checkpoint|node graph/i);
});
