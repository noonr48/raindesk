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
  assert.equal(turn.actions[0].status, 'proposed', 'permission gate persists the model proposal separately');
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

test('Watch mode is genuinely read-only, including legacy bridging and beat capture', async () => {
  direction.writeGraph(direction.emptyGraph());
  direction.setProject({ partnerMode: 'watch' });
  const before = direction.readGraph();
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() {
      return JSON.stringify({
        message: 'I see the fist beat.',
        interpretation: { kind: 'movement', movement: { actor: 'Tom', action: 'shakes his fist' }, confidence: 0.8 },
        nextMoves: [], workflowHints: ['character_motion'],
        boardActions: [{ type: 'create_beat', payload: { shotId: 'S01' } }],
      });
    } },
    directionImpl: direction,
  });
  const turn = await partner.turn({
    message: 'Tom shakes his fist before the fight',
    context: { legacyShotId: 'S01', legacyBeat: 'fight starts' },
  });
  assert.equal(turn.permissionMode, 'watch');
  assert.equal(turn.intentId, null);
  assert.equal(turn.captured, null);
  assert.equal(turn.boardActions[0].disposition, 'advisory');
  assert.equal(turn.actions[0].status, 'advisory');
  assert.deepEqual(direction.readGraph(), before, 'Watch mode performs no semantic project mutation');
});

test('Partner context pruning always sends valid JSON rather than a truncated fragment', async () => {
  direction.writeGraph(direction.emptyGraph());
  const seen = [];
  const partner = partnerModule.createPartner({
    agentImpl: { async chat(prompt) {
      const m = prompt.match(/Current context \(may be partial\):\n([\s\S]*?)\n\n/);
      assert.ok(m, 'context block present');
      const parsed = JSON.parse(m[1]);
      seen.push(parsed);
      return JSON.stringify({ message: 'Got it.', interpretation: { kind: 'review', confidence: 0.5 }, nextMoves: [] });
    } },
    directionImpl: direction,
  });
  await partner.turn({
    message: 'help me look at this',
    context: {
      canvas: { width: 1024, height: 1024 },
      nearbyNotes: Array.from({ length: 60 }, (_, i) => `note-${i} ${'x'.repeat(900)}`),
      visibleLayers: Array.from({ length: 40 }, (_, i) => ({ id: `L${i}`, kind: 'pen', visible: true })),
      artRevisionId: 'rev_test',
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].artRevisionId, 'rev_test');
  assert.ok(JSON.stringify(seen[0]).length <= 7000, 'context stays inside budget as valid JSON');
});

test('Partner enriches a pre-pinned Beat Trail entry instead of creating a duplicate', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'pin_scene', title: 'Fight' });
  direction.createShot({ id: 'pin_shot', sceneId: scene.id, title: 'Gesture' });
  const raw = direction.createBeat({
    id: 'pin_beat', shotId: 'pin_shot', rawDirection: 'he shakes his fist once',
    description: 'he shakes his fist once', source: { kind: 'user_beat_trail' },
  });
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return JSON.stringify({
      message: 'Yep, one sharp warning gesture.',
      interpretation: { kind: 'movement', movement: { actor: 'Tom', action: 'one sharp fist shake' }, confidence: 0.8 },
      nextMoves: [], workflowHints: ['character_motion'], boardActions: [],
    }); } },
    directionImpl: direction,
  });
  const turn = await partner.turn({
    message: raw.rawDirection,
    context: { sceneId: scene.id, shotId: 'pin_shot', precreatedBeatId: raw.id },
  });
  assert.equal(turn.captured.beatId, raw.id);
  assert.equal(turn.captured.enriched, true);
  const spec = direction.shotSpec('pin_shot');
  assert.equal(spec.beats.length, 1, 'no duplicate beat created');
  assert.equal(spec.beats[0].rawDirection, raw.rawDirection);
  assert.equal(spec.beats[0].movement.action, 'one sharp fist shake');
});

test('Partner preserves a multi-event directing interpretation and its useful timing relationships', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'multi_scene', title: 'Rooftop fight' });
  direction.createShot({ id: 'multi_shot', sceneId: scene.id, title: 'Closing exchange' });
  const partner = partnerModule.createPartner({
    agentImpl: { async chat(prompt) {
      assert.match(prompt, /split them into lightweight events/i);
      return JSON.stringify({
        message: 'I have the overlap and the push-in tied to the line.',
        interpretation: {
          kind: 'movement',
          movement: { actor: 'A', action: 'pre-fight exchange' },
          events: [
            { id: 'tongue', kind: 'performance', description: 'tongue click', actor: 'A' },
            { id: 'fist', kind: 'action', description: 'fist shake', actor: 'A', bodyPart: 'right fist' },
            { id: 'line', kind: 'dialogue', description: 'speaks', actor: 'A', dialogue: 'line' },
            { id: 'push', kind: 'camera', description: 'pushes inward', camera: { path: 'push in' } },
            { id: 'catch', kind: 'contact', description: 'catches wrist', actor: 'B', contact: { initiatorActor: 'B', initiatorBodyPart: 'left hand', receiverActor: 'A', receiverBodyPart: 'right wrist' } },
          ],
          relations: [
            { type: 'overlaps', from: 'tongue', to: 'fist' },
            { type: 'during', from: 'push', to: 'line' },
            { type: 'after', from: 'catch', to: 'line' },
          ],
          confidence: 0.9,
        },
        nextMoves: [], workflowHints: ['contact_action', 'camera_reveal'], boardActions: [],
      });
    } },
    directionImpl: direction,
  });
  const turn = await partner.turn({
    message: 'he clicks his tongue while shaking his fist, speaks as the camera pushes in, then she catches his wrist',
    context: { sceneId: scene.id, shotId: 'multi_shot' },
  });
  const beat = direction.shotSpec('multi_shot').beats.find((b) => b.id === turn.captured.beatId);
  assert.equal(beat.events.length, 5);
  assert.equal(beat.relations.length, 3);
  assert.equal(beat.events.find((e) => e.id === 'catch').kind, 'contact');
  assert.equal(beat.relations.find((r) => r.type === 'during').to, 'line');
});

test('Partner persists recent conversation so short follow-ups can refer to prior creative choices', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'memory_scene', title: 'Choice' });
  direction.createShot({ id: 'memory_shot', sceneId: scene.id, title: 'Three takes' });
  const prompts = [];
  const partner = partnerModule.createPartner({
    agentImpl: { async chat(prompt) {
      prompts.push(prompt);
      return JSON.stringify({
        message: prompts.length === 1 ? 'I would keep three rough directions.' : 'Got it - the second direction, expression only.',
        interpretation: { kind: 'review', confidence: 0.7 },
        nextMoves: [], workflowHints: [], boardActions: [],
      });
    } },
    directionImpl: direction,
  });
  const first = await partner.turn({ message: 'make three rough directions', context: { sceneId: scene.id, shotId: 'memory_shot' } });
  const second = await partner.turn({ message: 'use the second one, but only its expression', context: { sceneId: scene.id, shotId: 'memory_shot' } });
  assert.ok(first.turnId);
  assert.ok(second.turnId);
  assert.match(prompts[1], /make three rough directions/);
  assert.match(prompts[1], /I would keep three rough directions/);
});

test('Partner receives bounded persistent workspace objects so spatial language can target stable panels', async () => {
  direction.writeGraph(direction.emptyGraph());
  const seen = [];
  const partner = partnerModule.createPartner({
    agentImpl: { async chat(prompt) {
      const m = prompt.match(/Current context \(may be partial\):\n([\s\S]*?)\n\n/);
      assert.ok(m);
      const ctx = JSON.parse(m[1]); seen.push(ctx);
      return JSON.stringify({ message: 'I can move the Partner card beside the beats.', interpretation: { kind: 'setup', confidence: 0.7 }, nextMoves: [], boardActions: [] });
    } },
    directionImpl: direction,
  });
  await partner.turn({
    message: 'move yourself beside the beats',
    context: {
      workspace: {
        viewport: { x: 0, y: 0, zoom: 1 },
        objects: [
          { id: 'panel_partner', type: 'partner_panel', x: 1000, y: 90, width: 330, height: 580, dock: 'right', visible: true },
          { id: 'panel_beats', type: 'beat_trail', x: 600, y: 520, width: 350, height: 300, visible: true },
        ],
      },
    },
  });
  assert.equal(seen[0].workspace.objects[0].id, 'panel_partner');
  assert.equal(seen[0].workspace.objects[1].id, 'panel_beats');
  assert.equal(seen[0].workspace.objects[0].dock, 'right');
});

test('Partner receives keep/change boundaries and active beat context as directing constraints', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'constraint_partner_scene', title: 'Close fight' });
  direction.createShot({
    id: 'constraint_partner_shot', sceneId: scene.id, title: 'Hand catch',
    preserve: ['face identity', 'camera framing'], change: ['right hand pose'],
  });
  const beat = direction.createBeat({ id: 'constraint_partner_beat', shotId: 'constraint_partner_shot', rawDirection: 'she catches his wrist' });
  let seen;
  const partner = partnerModule.createPartner({
    agentImpl: { async chat(prompt) {
      assert.match(prompt, /keep\/preserve constraints/i);
      const m = prompt.match(/Current context \(may be partial\):\n([\s\S]*?)\n\n/);
      seen = JSON.parse(m[1]);
      return JSON.stringify({ message: 'I will keep the face and framing fixed.', interpretation: { kind: 'review', confidence: 0.8 }, nextMoves: [] });
    } },
    directionImpl: direction,
  });
  await partner.turn({
    message: 'only change the hand',
    context: {
      sceneId: scene.id, shotId: 'constraint_partner_shot', activeBeatId: beat.id,
      activeBeat: { id: beat.id, order: 1, rawDirection: beat.rawDirection },
      directingConstraints: { preserve: ['face identity', 'camera framing'], change: ['right hand pose'] },
    },
  });
  assert.equal(seen.activeBeatId, beat.id);
  assert.equal(seen.activeBeat.rawDirection, 'she catches his wrist');
  assert.deepEqual(seen.direction.activeShot.preserve, ['face identity', 'camera framing']);
  assert.deepEqual(seen.direction.activeShot.change, ['right hand pose']);
  assert.deepEqual(seen.directingConstraints.change, ['right hand pose']);
});

test('beat-scoped DIRECT annotation enriches the selected beat instead of creating a duplicate', async () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'direct_mark_scene', title: 'Fight' });
  direction.createShot({ id: 'direct_mark_shot', sceneId: scene.id, title: 'Contact' });
  const rawBeat = direction.createBeat({
    id: 'direct_mark_beat', shotId: 'direct_mark_shot', rawDirection: 'she catches his wrist',
    description: 'she catches his wrist', source: { kind: 'user_beat_trail' },
  });
  const partner = partnerModule.createPartner({
    agentImpl: { async chat() { return JSON.stringify({
      message: 'Yep — this arrow is the catch path for this beat.',
      interpretation: {
        kind: 'movement', movement: { actor: 'She', action: 'left hand catches wrist', bodyPart: 'left hand' },
        events: [{ id: 'catch', kind: 'contact', description: 'hand catches wrist', actor: 'She', contact: { initiatorActor: 'She', initiatorBodyPart: 'left hand', receiverBodyPart: 'wrist' } }],
        confidence: 0.9,
      },
      nextMoves: [], workflowHints: ['contact_action'], boardActions: [],
    }); } },
    directionImpl: direction,
  });
  const turn = await partner.turn({
    message: 'I drew this direction: her hand lands here',
    context: {
      sceneId: scene.id, shotId: 'direct_mark_shot', activeBeatId: rawBeat.id,
      surface: 'direction_annotation', selection: { type: 'direction_annotation', rawText: 'her hand lands here' },
    },
  });
  assert.equal(turn.captured.beatId, rawBeat.id);
  assert.equal(turn.captured.fromDirectionAnnotation, true);
  const spec = direction.shotSpec('direct_mark_shot');
  assert.equal(spec.beats.length, 1, 'DIRECT detail must not create a second beat');
  assert.equal(spec.beats[0].rawDirection, 'she catches his wrist', 'raw Beat Trail wording stays authoritative');
  assert.equal(spec.beats[0].events[0].kind, 'contact');
});

test('an identical resent message reuses the prior captured beat instead of stacking a duplicate', async () => {
  const scene = direction.createScene({ id: 'dupe_scene', title: 'Resend' });
  direction.createShot({ id: 'dupe_shot', sceneId: scene.id, title: 'Resend shot' });
  const fakeAgent = { async chat() { return JSON.stringify({
    message: 'read it again the same way',
    interpretation: { kind: 'movement', movement: { actor: 'A', action: 'shakes fist', bodyPart: 'fist' }, confidence: 0.8 },
    nextMoves: [], workflowHints: ['character_motion'], boardActions: [],
  }); } };
  const partner = partnerModule.createPartner({ agentImpl: fakeAgent, directionImpl: direction });
  const input = { message: 'the character shakes his fist before the fight', context: { sceneId: 'dupe_scene', shotId: 'dupe_shot' } };
  const first = await partner.turn(input);
  const second = await partner.turn(input);
  assert.equal(second.captured.beatId, first.captured.beatId);
  assert.equal(second.captured.existing, true);
  assert.equal(second.captured.deduped, true);
  const spec = direction.shotSpec('dupe_shot');
  assert.equal(spec.beats.length, 1, 'resent identical direction must not stack a duplicate provisional beat');
});
