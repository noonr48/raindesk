'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-partner-'));
process.env.RAINDESK_DATA_DIR = scratch;

const direction = require('../../lib/direction');
const partnerModule = require('../../lib/partner');
const router = require('../../lib/workflow-router');

test('structured partner turn keeps casual message and routes movement/camera work', async () => {
  const scene = direction.createScene({ id: 'roof', title: 'Rooftop fight' });
  direction.createShot({ id: 'roof_s1', sceneId: scene.id, title: 'Face push-in' });

  const fakeAgent = {
    async chat(prompt) {
      assert.match(prompt, /scene -> shot -> beat/i);
      assert.match(prompt, /clicks his tongue/i);
      return JSON.stringify({
        message: "Yep — I read that as one cocky pre-fight beat. I'll keep the stance, let the tongue click start the gesture, then give the fist one controlled shake before the attack.",
        interpretation: {
          kind: 'movement',
          movement: {
            actor: 'Character A',
            preparation: 'held fighting stance',
            action: 'tongue click + one fist shake',
            bodyPart: 'mouth and fist',
            timing: 'overlap; before attack',
            emotion: 'provocation',
          },
          camera: {},
          preserve: ['fighting stance'],
          confidence: 0.9,
        },
        nextMoves: [
          { label: 'Block the gesture', prompt: 'Block the tongue click and fist shake as a micro-beat.' },
          { label: 'Add the camera push', prompt: 'Now connect the camera push to the line.' },
        ],
        workflowHints: ['performance_closeup'],
        boardActions: [{ type: 'create_beat', payload: { shotId: 'roof_s1' } }],
      });
    },
  };

  const partner = partnerModule.createPartner({ agentImpl: fakeAgent, directionImpl: direction });
  const turn = await partner.turn({
    message: 'the character clicks his tongue while shaking his fist before a fight',
    context: { sceneId: 'roof', shotId: 'roof_s1' },
  });

  assert.match(turn.message, /pre-fight beat/i);
  assert.equal(turn.interpretation.kind, 'movement');
  assert.equal(turn.nextMoves.length, 2);
  assert.ok(turn.workflow.some((w) => w.id === 'performance_closeup'));
  assert.equal(turn.boardActions[0].disposition, 'proposal');
  assert.ok(turn.intentId);
  const saved = direction.readGraph().intents.at(-1);
  assert.equal(saved.interpretation.movement.emotion, 'provocation');
});

test('blank-project kickstart returns reaction-sized choices even if agent reply is unusable', async () => {
  // Isolate this test from the prior graph by replacing persisted state.
  direction.writeGraph(direction.emptyGraph());
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return ''; } },
    directionImpl: direction,
  });
  const turn = await partner.turn({ mode: 'kickstart', message: '' });
  assert.equal(turn.kickstart, true);
  assert.match(turn.message, /don't need to solve the whole project/i);
  assert.equal(turn.nextMoves.length, 3);
  assert.equal(turn.nextMoves[0].label, 'Lay out 3 rough starting shots');
  assert.equal(turn.workflow[0].id, 'creative_kickstart');
});

test('router recognizes camera, contact and animatic intent without model-specific tools', () => {
  const camera = router.rankRecipes('spiral the camera from behind them up into a close shot');
  assert.equal(camera[0].id, 'camera_reveal');
  const contact = router.rankRecipes('she catches his wrist before the punch lands');
  assert.ok(contact.some((x) => x.id === 'contact_action'));
  const timing = router.rankRecipes('hold for 12 frames then cut into the animatic');
  assert.ok(timing.some((x) => x.id === 'animatic_pass'));
  for (const recipe of [...camera, ...contact, ...timing]) {
    assert.doesNotMatch(JSON.stringify(recipe), /ComfyUI|ControlNet|SDXL|node/i);
  }
});
