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
