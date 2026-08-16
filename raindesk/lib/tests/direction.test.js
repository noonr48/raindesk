'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-direction-'));
process.env.RAINDESK_DATA_DIR = scratch;

const direction = require('../../lib/direction');

test('direction graph seeds blank and persists scene -> shot -> beat', () => {
  const start = direction.readGraph();
  assert.equal(start.project.creativeState, 'blank');
  assert.equal(start.project.partnerMode, 'suggest');
  assert.equal(start.scenes.length, 0);

  const scene = direction.createScene({
    id: 'roof_fight',
    title: 'Rooftop confrontation',
    description: 'Two people are fighting on a rooftop.',
  });
  const shot = direction.createShot({
    id: 'roof_04',
    sceneId: scene.id,
    title: 'Closing distance',
    camera: { path: 'slow push toward both faces' },
  });
  const beat = direction.createBeat({
    id: 'roof_04_b1',
    shotId: shot.id,
    rawDirection: 'He clicks his tongue while shaking his fist before the fight.',
    movement: {
      actor: 'Character A',
      preparation: 'held fighting stance',
      action: 'click tongue while shaking fist once',
      timing: 'before the attack',
      emotion: 'provocation',
    },
  });

  const reread = direction.readGraph();
  assert.equal(reread.project.activeSceneId, scene.id);
  assert.equal(reread.project.activeShotId, shot.id);
  assert.equal(reread.project.creativeState, 'developing');
  assert.equal(reread.beats[0].id, beat.id);
  assert.equal(reread.beats[0].movement.emotion, 'provocation');
  assert.equal(reread.beats[0].rawDirection, 'He clicks his tongue while shaking his fist before the fight.');
});

test('annotation preserves raw marks beside provisional interpretation', () => {
  const ann = direction.addAnnotation({
    id: 'camera_arrow_1',
    scopeType: 'shot',
    scopeId: 'roof_04',
    kind: 'camera_path',
    rawText: 'camera scopes from bottom up, from behind the character in a spiral motion up their face',
    geometry: { type: 'path', points: [[0.2, 0.8], [0.45, 0.5], [0.7, 0.2]] },
    interpretation: {
      start: 'low rear three-quarter',
      path: 'rising curved orbit',
      end: 'face close-up',
    },
    confidence: 0.82,
  });
  assert.equal(ann.kind, 'camera_path');
  assert.equal(ann.status, 'provisional');
  assert.match(ann.rawText, /spiral motion/);
  const s = direction.summary();
  assert.equal(s.activeAnnotations.length, 1);
  assert.equal(s.activeAnnotations[0].interpretation.end, 'face close-up');
});

test('project partner permission mode validates watch/suggest/act', () => {
  direction.setProject({ partnerMode: 'act' });
  assert.equal(direction.readGraph().project.partnerMode, 'act');
  assert.throws(() => direction.setProject({ partnerMode: 'reckless' }), (e) => e.status === 400);
});


test('legacy shot bridge is idempotent and preserves the old board identity', () => {
  direction.writeGraph(direction.emptyGraph());
  const first = direction.ensureLegacyShot('S03', { beat: 'truck loses grip' });
  const second = direction.ensureLegacyShot('S03', { beat: 'new wording should not duplicate' });
  assert.equal(first.sceneId, 'legacy_board');
  assert.equal(first.shotId, 'S03');
  assert.equal(second.shotId, first.shotId);
  const graph = direction.readGraph();
  assert.equal(graph.scenes.filter((scene) => scene.id === 'legacy_board').length, 1);
  assert.equal(graph.shots.filter((shot) => shot.source && shot.source.legacyShotId === 'S03').length, 1);
  assert.equal(graph.shots[0].description, 'truck loses grip');
  assert.equal(graph.project.activeShotId, 'S03');
});


test('camera endpoints become camera cues while explicit visual frame refs stay separate', () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'anchor_scene', title: 'Camera reveal' });
  direction.createShot({ id: 'anchor_shot', sceneId: scene.id, title: 'Rise to face' });
  direction.createBeat({ id: 'anchor_beat', shotId: 'anchor_shot', rawDirection: 'she rises into frame' });
  direction.addAnnotation({
    id: 'anchor_camera_arrow', scopeType: 'shot', scopeId: 'anchor_shot',
    kind: 'camera_path', rawText: 'camera rises from low behind to face',
  });

  const start = direction.setShotAnchor('anchor_shot', 'start', {
    kind: 'direction_path_endpoint', point: { x: 100, y: 900 },
    framing: 'low behind character', sourceAnnotationId: 'anchor_camera_arrow',
  });
  const end = direction.setShotAnchor('anchor_shot', 'end', {
    kind: 'direction_path_endpoint', point: { x: 700, y: 180 },
    framing: 'close on face', sourceAnnotationId: 'anchor_camera_arrow',
  });
  assert.deepEqual(start.point, { x: 100, y: 900 });
  assert.equal(end.framing, 'close on face');

  let spec = direction.shotSpec('anchor_shot');
  assert.equal(spec.shot.startFrame, null, 'drawn cue is not mislabeled as a real start frame');
  assert.equal(spec.shot.endFrame, null, 'drawn cue is not mislabeled as a real landing frame');
  assert.equal(spec.shot.cameraCues.start.framing, 'low behind character');
  assert.equal(spec.shot.cameraCues.end.framing, 'close on face');

  direction.setShotFrameRef('anchor_shot', 'start', {
    kind: 'sketch_reference', referenceId: 'sketch_start_1', framing: 'low rear sketch',
  });
  direction.setShotFrameRef('anchor_shot', 'end', {
    kind: 'sketch_reference', imageUrl: '/api/blob/' + 'a'.repeat(64), framing: 'face close-up sketch',
  });
  spec = direction.shotSpec('anchor_shot');
  assert.equal(spec.shot.startFrame.referenceId, 'sketch_start_1');
  assert.match(spec.shot.endFrame.imageUrl, /^\/api\/blob\//);
  assert.equal(spec.beats.some((b) => b.id === 'anchor_beat'), true);
  assert.equal(spec.annotations.some((a) => a.id === 'anchor_camera_arrow'), true);
});

test('shot anchors validate slot and unknown shot without mutating the graph', () => {
  assert.throws(() => direction.setShotAnchor('roof_04', 'middle', {}), (e) => e.status === 400);
  assert.throws(() => direction.setShotAnchor('missing_shot', 'start', {}), (e) => e.status === 404);
  assert.throws(() => direction.setShotFrameRef('anchor_shot', 'start', { framing: 'no actual ref' }), (e) => e.status === 400);
});

test('beat enrichment preserves the artist raw wording while adding Partner structure', () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'enrich_scene', title: 'Fight' });
  direction.createShot({ id: 'enrich_shot', sceneId: scene.id, title: 'Gesture' });
  const beat = direction.createBeat({
    id: 'enrich_beat', shotId: 'enrich_shot',
    rawDirection: 'he clicks his tongue while shaking his fist',
    description: 'he clicks his tongue while shaking his fist',
    source: { kind: 'user_beat_trail' },
  });
  const enriched = direction.updateBeat(beat.id, {
    description: 'one provocative pre-fight gesture',
    movement: { actor: 'Tom', action: 'tongue click + one fist shake', timing: 'overlap' },
    enrichment: { kind: 'partner_capture', intentId: 'intent_x' },
  });
  assert.equal(enriched.rawDirection, 'he clicks his tongue while shaking his fist');
  assert.equal(enriched.movement.actor, 'Tom');
  assert.equal(enriched.enrichments.at(-1).intentId, 'intent_x');
});

test('beat event graph represents overlapping performance, dialogue, camera and contact without flattening raw direction', () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'event_scene', title: 'Rooftop fight' });
  direction.createShot({ id: 'event_shot', sceneId: scene.id, title: 'Closing exchange' });
  const rawDirection = 'He clicks his tongue while shaking his fist. She steps closer. He speaks as the camera moves inward, then she catches his wrist and he twists his shoulder away.';
  const beat = direction.createBeat({
    id: 'event_beat', shotId: 'event_shot', rawDirection,
    events: [
      { id: 'tongue', kind: 'performance', description: 'clicks tongue', actor: 'A', bodyPart: 'mouth', sound: 'tongue click' },
      { id: 'fist', kind: 'action', description: 'shakes fist once', actor: 'A', bodyPart: 'right fist' },
      { id: 'step', kind: 'action', description: 'steps closer', actor: 'B' },
      { id: 'line', kind: 'dialogue', description: 'speaks the line', actor: 'A', dialogue: 'spoken line' },
      { id: 'push', kind: 'camera', description: 'camera moves inward', camera: { path: 'push in toward both faces' } },
      { id: 'catch', kind: 'contact', description: 'catches his wrist', actor: 'B', contact: { initiatorActor: 'B', initiatorBodyPart: 'left hand', receiverActor: 'A', receiverBodyPart: 'right wrist', quality: 'controlled catch' } },
      { id: 'twist', kind: 'action', description: 'twists shoulder away', actor: 'A', bodyPart: 'shoulder' },
    ],
    relations: [
      { type: 'overlaps', from: 'tongue', to: 'fist' },
      { type: 'before', from: 'step', to: 'line' },
      { type: 'during', from: 'push', to: 'line' },
      { type: 'after', from: 'catch', to: 'line' },
      { type: 'follows', from: 'twist', to: 'catch' },
    ],
  });
  assert.equal(beat.rawDirection, rawDirection);
  assert.equal(beat.events.length, 7);
  assert.equal(beat.events.find((e) => e.id === 'catch').contact.receiverBodyPart, 'right wrist');
  assert.deepEqual(beat.relations.map((r) => r.type), ['overlaps', 'before', 'during', 'after', 'follows']);
  assert.equal(direction.shotSpec('event_shot').beats[0].events.length, 7);
});

test('simple movement still synthesizes one lightweight event and invalid relations are ignored', () => {
  direction.writeGraph(direction.emptyGraph());
  const scene = direction.createScene({ id: 'simple_event_scene', title: 'Gesture' });
  direction.createShot({ id: 'simple_event_shot', sceneId: scene.id, title: 'Warning' });
  const beat = direction.createBeat({
    id: 'simple_event_beat', shotId: 'simple_event_shot',
    rawDirection: 'Tom shakes his fist once',
    movement: { actor: 'Tom', action: 'shakes his fist once', bodyPart: 'fist' },
    relations: [{ type: 'before', from: 'missing', to: 'movement' }],
  });
  assert.equal(beat.events.length, 1);
  assert.equal(beat.events[0].id, 'movement');
  assert.equal(beat.events[0].actor, 'Tom');
  assert.deepEqual(beat.relations, []);
});

test('schema v1 migration unifies legacy bridge shot ids with artwork/document ids without losing semantic references', () => {
  const old = {
    schemaVersion: 1,
    project: { id: 'project', title: 'Old project', creativeState: 'developing', partnerMode: 'suggest', activeSceneId: 'legacy_board', activeShotId: 'legacy_S05' },
    scenes: [{ id: 'legacy_board', title: 'Working board', status: 'provisional' }],
    shots: [{ id: 'legacy_S05', sceneId: 'legacy_board', title: 'S05', camera: {}, source: { kind: 'legacy_board_bridge', legacyShotId: 'S05' } }],
    beats: [{ id: 'old_beat', shotId: 'legacy_S05', order: 1, rawDirection: 'she turns her head', movement: { actor: 'Anna', action: 'turns head' }, camera: {}, dialogue: '', status: 'provisional' }],
    annotations: [{ id: 'old_ann', scopeType: 'shot', scopeId: 'legacy_S05', kind: 'actor_motion', rawText: 'turn here', status: 'provisional' }],
    intents: [{ id: 'old_intent', raw: 'turn', kind: 'movement', shotId: 'legacy_S05', status: 'provisional' }],
    decisions: [], openQuestions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(direction.DIRECTION_PATH, JSON.stringify(old), 'utf8');
  const migrated = direction.readGraph();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.shots[0].id, 'S05');
  assert.equal(migrated.project.activeShotId, 'S05');
  assert.equal(migrated.beats[0].shotId, 'S05');
  assert.equal(migrated.annotations[0].scopeId, 'S05');
  assert.equal(migrated.intents[0].shotId, 'S05');
  assert.equal(migrated.beats[0].rawDirection, 'she turns her head');
  assert.equal(migrated.beats[0].events.length, 1);
  assert.deepEqual(migrated.project.mediums, ['storyboard', 'comic', 'animation']);
});
