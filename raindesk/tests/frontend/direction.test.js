'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const DIR = require('../../public/js/direction');

test('direction path geometry preserves start/end and clamps to canvas', () => {
  const geometry = DIR.pathGeometry([
    { x: -10, y: 20 },
    { x: 10, y: 20 },
    { x: 10.5, y: 20.4 },
    { x: 500, y: 1200 },
  ], 1024, 1024);
  assert.equal(geometry.type, 'path');
  assert.equal(geometry.arrow, true);
  assert.deepEqual(geometry.points[0], { x: 0, y: 20 });
  assert.deepEqual(geometry.points.at(-1), { x: 500, y: 1024 });
  assert.ok(geometry.points.length >= 3);
});

test('partner interpretation maps camera and movement to visual annotation kinds', () => {
  assert.equal(DIR.kindFromInterpretation({ kind: 'camera' }), 'camera_path');
  assert.equal(DIR.kindFromInterpretation({ kind: 'movement' }), 'actor_motion');
  assert.equal(DIR.kindFromInterpretation({ kind: 'performance' }), 'actor_motion');
  assert.equal(DIR.kindFromInterpretation({ kind: 'camera', annotationKind: 'framing' }), 'framing');
  assert.equal(DIR.kindFromInterpretation({ kind: 'setup' }), 'unknown');
});

test('visual direction bridge creates provisional scope, asks partner, then stores raw mark + interpretation', async () => {
  const calls = [];
  const graph = { scenes: [], shots: [], annotations: [] };
  const api = {
    async getDirection() { return graph; },
    async createDirectionScene(scene) { graph.scenes.push(scene); return { scene }; },
    async createDirectionShot(shot) { graph.shots.push(shot); return { shot }; },
    async partnerTurn(message, opts) {
      calls.push({ kind: 'partner', message, opts });
      return {
        intentId: 'intent_1',
        interpretation: {
          kind: 'camera',
          annotationKind: 'camera_path',
          camera: { path: 'rising spiral', framingEnd: 'face close-up' },
          confidence: 0.88,
        },
      };
    },
    async addDirectionAnnotation(annotation) {
      calls.push({ kind: 'save', annotation });
      graph.annotations.push({ id: 'ann_1', ...annotation });
      return { annotation: graph.annotations.at(-1) };
    },
    async setDirectionShotAnchor(shotId, slot, anchor) {
      calls.push({ kind: 'anchor', shotId, slot, anchor });
      return { ok: true, anchor };
    },
  };

  const result = await DIR.interpretAndSavePath(api, {
    legacyShot: { id: 'S03', beat: 'Rooftop turn' },
    points: [{ x: 100, y: 900 }, { x: 400, y: 500 }, { x: 700, y: 180 }],
    caption: 'camera spirals from behind them up to the face',
  });

  assert.equal(result.scope.shotId, 'legacy_S03');
  assert.equal(graph.scenes[0].id, 'legacy_board');
  assert.equal(graph.shots[0].source.legacyShotId, 'S03');
  assert.match(calls[0].message, /camera spirals/);
  assert.equal(calls[0].opts.context.selection.type, 'direction_annotation');
  assert.equal(calls[1].annotation.kind, 'camera_path');
  assert.equal(calls[1].annotation.rawText, 'camera spirals from behind them up to the face');
  assert.equal(calls[1].annotation.source.intentId, 'intent_1');
  assert.equal(calls[1].annotation.interpretation.camera.framingEnd, 'face close-up');
  assert.equal(calls[2].kind, 'anchor');
  assert.equal(calls[2].slot, 'start');
  assert.deepEqual(calls[2].anchor.point, { x: 100, y: 900 });
  assert.equal(calls[3].slot, 'end');
  assert.deepEqual(calls[3].anchor.point, { x: 700, y: 180 });
  assert.equal(calls[3].anchor.framing, 'face close-up');
  assert.ok(result.anchors);
});

test('visual direction mark is still saved when partner is temporarily unavailable', async () => {
  const graph = {
    scenes: [{ id: 'legacy_board' }],
    shots: [{ id: 'legacy_S01', sceneId: 'legacy_board', source: { kind: 'legacy_board_bridge', legacyShotId: 'S01' } }],
    annotations: [],
  };
  const api = {
    async getDirection() { return graph; },
    async partnerTurn() { throw Object.assign(new Error('offline'), { status: 503 }); },
    async addDirectionAnnotation(annotation) {
      const saved = { id: 'ann_offline', ...annotation };
      graph.annotations.push(saved);
      return { annotation: saved };
    },
  };
  const result = await DIR.interpretAndSavePath(api, {
    legacyShot: { id: 'S01', beat: 'opening' },
    points: [{ x: 1, y: 1 }, { x: 30, y: 30 }],
    caption: 'hand moves upward',
  });
  assert.ok(result.partnerError);
  assert.equal(result.annotation.kind, 'unknown');
  assert.equal(result.annotation.rawText, 'hand moves upward');
  assert.equal(result.annotation.source.partnerAvailable, false);
});


test('camera path endpoints are represented as lightweight frame anchors', () => {
  const anchors = DIR.anchorsFromPath({
    id: 'ann_cam', rawText: 'rise from boots to face',
    geometry: { points: [{ x: 20, y: 900 }, { x: 500, y: 120 }] },
  }, { camera: { framingStart: 'boots / low rear', framingEnd: 'face close-up' } });
  assert.equal(anchors.start.framing, 'boots / low rear');
  assert.equal(anchors.end.framing, 'face close-up');
  assert.equal(anchors.start.sourceAnnotationId, 'ann_cam');
});
