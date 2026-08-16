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
  assert.ok(turn.captured && turn.captured.beatId, 'interpreted movement is documented as a provisional beat');
  const after = direction.readGraph();
  const saved = after.intents.at(-1);
  assert.equal(saved.interpretation.movement.emotion, 'provocation');
  const capturedBeat = after.beats.find((beat) => beat.id === turn.captured.beatId);
  assert.equal(capturedBeat.rawDirection, 'the character clicks his tongue while shaking his fist before a fight');
  assert.equal(capturedBeat.movement.action, 'tongue click + one fist shake');
  assert.equal(capturedBeat.source.intentId, turn.intentId);
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
  const motion = router.rankRecipes('he shakes his fist once, shifts his weight, then lunges');
  assert.ok(motion.some((x) => x.id === 'character_motion'));
  const contact = router.rankRecipes('she catches his wrist before the punch lands');
  assert.ok(contact.some((x) => x.id === 'contact_action'));
  const timing = router.rankRecipes('hold for 12 frames then cut into the animatic');
  assert.ok(timing.some((x) => x.id === 'animatic_pass'));
  for (const recipe of [...camera, ...contact, ...timing]) {
    assert.doesNotMatch(JSON.stringify(recipe), /ComfyUI|ControlNet|SDXL|node/i);
  }
});


test('legacy storyboard chat is quietly bridged into Direction Graph and movement is documented', async () => {
  direction.writeGraph(direction.emptyGraph());
  const fakeAgent = {
    async chat() {
      return JSON.stringify({
        message: 'I read it as one restrained gesture before the attack.',
        interpretation: {
          kind: 'movement',
          movement: { actor: 'Tom', action: 'shake fist once', timing: 'before attack' },
          preserve: ['stance'],
          confidence: 0.86,
        },
        nextMoves: [], workflowHints: ['performance_closeup'], boardActions: [],
      });
    },
  };
  const partner = partnerModule.createPartner({ agentImpl: fakeAgent, directionImpl: direction });
  const turn = await partner.turn({
    message: 'Tom shakes his fist once before he lunges',
    context: { legacyShotId: 'S04', legacyBeat: 'rooftop confrontation', surface: 'storyboard_canvas' },
  });
  assert.ok(turn.captured && turn.captured.beatId);
  const graph = direction.readGraph();
  const shot = graph.shots.find((item) => item.source && item.source.legacyShotId === 'S04');
  assert.ok(shot, 'legacy board shot receives a Direction Graph scope');
  assert.equal(graph.project.activeShotId, shot.id);
  const beat = graph.beats.find((item) => item.id === turn.captured.beatId);
  assert.equal(beat.shotId, shot.id);
  assert.equal(beat.rawDirection, 'Tom shakes his fist once before he lunges');
  assert.equal(beat.movement.actor, 'Tom');
});


test('non-JSON agent replies still preserve obvious movement as a provisional beat', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'fallback_scene', title: 'Pre-fight' });
  direction.createShot({ id: 'fallback_shot', sceneId: scene.id, title: 'Gesture' });
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return 'still with you'; } },
    directionImpl: direction,
  });
  const turn = await partner.turn({
    message: 'he clicks his tongue while shaking his fist before the fight',
    context: { sceneId: scene.id, shotId: 'fallback_shot' },
  });
  assert.equal(turn.interpretation.kind, 'movement');
  assert.match(turn.interpretation.movement.action, /shaking his fist/);
  assert.match(turn.interpretation.movement.timing, /while|before/i);
  assert.ok(turn.workflow.some((x) => x.id === 'character_motion'));
  assert.ok(turn.captured && turn.captured.beatId);
  const beat = direction.shotSpec('fallback_shot').beats.at(-1);
  assert.equal(beat.rawDirection, 'he clicks his tongue while shaking his fist before the fight');
});

test('fallback interpretation recognizes camera language without inventing a tool', () => {
  const interpreted = partnerModule.fallbackInterpretation(
    'camera spirals from low behind her and lands close on the face',
  );
  assert.equal(interpreted.kind, 'camera');
  assert.match(interpreted.camera.path, /spirals/);
  assert.ok(interpreted.confidence < 0.5, 'fallback stays explicitly provisional');
});
