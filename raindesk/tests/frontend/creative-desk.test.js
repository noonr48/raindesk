'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const desk = require('../../public/js/creative-desk');

test('Creative Desk world/screen transforms round-trip through persistent viewport', () => {
  const metrics = { width: 1400, height: 900 };
  const viewport = { x: 120, y: -55, zoom: 0.8 };
  const world = { x: 330, y: -210 };
  const screen = desk.worldToScreen(world, viewport, metrics);
  const round = desk.screenToWorld(screen, viewport, metrics);
  assert.ok(Math.abs(round.x - world.x) < 1e-8);
  assert.ok(Math.abs(round.y - world.y) < 1e-8);
});

test('zoomAround keeps the world point beneath the cursor fixed', () => {
  const metrics = { width: 1200, height: 800 };
  const before = { x: 50, y: 20, zoom: 1 };
  const cursor = { x: 820, y: 260 };
  const anchor = desk.screenToWorld(cursor, before, metrics);
  const after = desk.zoomAround(cursor, 1.7, before, metrics);
  const projected = desk.worldToScreen(anchor, after, metrics);
  assert.ok(Math.abs(projected.x - cursor.x) < 1e-8);
  assert.ok(Math.abs(projected.y - cursor.y) < 1e-8);
});

test('Creative Desk seeds shot, character and reference objects explicitly in world space', () => {
  const objects = desk.defaultWorldObjects('S03');
  assert.deepEqual(objects.map((o) => o.space), ['world', 'world', 'world']);
  assert.equal(objects[0].id, 'world_shot_S03');
  assert.equal(objects[0].locked, true);
  assert.equal(objects[1].type, 'character_canvas');
  assert.equal(objects[2].type, 'reference_board');
});

test('focusViewport centers a world object without mutating its transform', () => {
  const obj = { x: 600, y: -200, width: 400, height: 500, scale: 1 };
  const metrics = { width: 1440, height: 900 };
  const vp = desk.focusViewport(obj, { x: 0, y: 0, zoom: 1 }, metrics, { zoom: 0.9 });
  const centre = desk.worldToScreen({ x: 800, y: 50 }, vp, metrics);
  assert.ok(Math.abs(centre.x - 720) < 1e-8);
  assert.ok(Math.abs(centre.y - 450) < 1e-8);
});
