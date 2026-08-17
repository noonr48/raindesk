'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-capability-partner-'));
process.env.RAINDESK_DATA_DIR = scratch;

const direction = require('../direction');
const partnerModule = require('../partner');

test('Partner turn exposes deterministic capability plan after creative interpretation', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'cap_scene', title: 'Hand adjustment' });
  direction.createShot({ id: 'cap_shot', sceneId: scene.id, title: 'Close hand fix' });

  const fakeAgent = {
    async chat() {
      return JSON.stringify({
        message: 'I will keep the rest fixed and only adjust the hand.',
        interpretation: {
          kind: 'edit',
          editScope: 'right hand only',
          preserve: ['face identity', 'framing'],
          confidence: 0.9,
        },
        nextMoves: [],
        workflowHints: ['local_refinement'],
        boardActions: [],
      });
    },
  };

  const partner = partnerModule.createPartner({ agentImpl: fakeAgent, directionImpl: direction });
  const turn = await partner.turn({
    message: 'only change the right hand, keep everything else',
    context: {
      sceneId: scene.id,
      shotId: 'cap_shot',
      selection: { type: 'lasso', lasso: [[10, 10], [60, 10], [60, 60], [10, 60]] },
    },
  });

  assert.ok(turn.executionPlan);
  assert.ok(turn.executionPlan.recipeIds.includes('local_refinement'));
  const image = turn.executionPlan.stages.find((stage) => stage.capabilityId === 'local_image_take');
  assert.equal(image.state, 'review_take');
  assert.equal(turn.executionPlan.reviewRequired, true);
  assert.equal(turn.executionPlan.status, 'ready');
});

test('Partner cannot promote missing pose adapter merely by requesting character motion', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'motion_scene', title: 'Fight' });
  direction.createShot({ id: 'motion_shot', sceneId: scene.id, title: 'Lunge' });

  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return JSON.stringify({
      message: 'I read it as a weight shift into the lunge.',
      interpretation: { kind: 'movement', movement: { actor: 'A', action: 'shifts weight then lunges' }, confidence: 0.8 },
      nextMoves: [], workflowHints: ['character_motion'], boardActions: [],
    }); } },
    directionImpl: direction,
  });

  const turn = await partner.turn({
    message: 'she shifts her weight then lunges',
    context: { sceneId: scene.id, shotId: 'motion_shot' },
  });
  const pose = turn.executionPlan.stages.find((stage) => stage.capabilityId === 'pose_blocking');
  assert.ok(pose);
  assert.equal(pose.state, 'planning_only');
  assert.equal(pose.executor, null);
  assert.equal(turn.executionPlan.status, 'planning_only');
});
