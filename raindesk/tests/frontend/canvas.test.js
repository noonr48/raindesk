'use strict';

/*
 * Raindesk canvas core tests (node:test, DOM-free by design).
 * Run from raindesk/:  node --test tests/frontend/
 *
 * Covers (per build brief acceptance #4 + task list):
 *   - layer add / select / kind locking
 *   - pen stroke recorded as vector data + rasterized
 *   - mask + region export: PNG magic, dims %8, white-on-black lasso
 *   - commit changes ONLY inside-lasso pixels (outside byte-identical)
 *   - take stack: re-GEN (push), prev/next, undo, discard
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const RC = require('../../public/js/canvas.js');
const { RainCanvasCore, encodePNG, decodePNG, scanlineFill } = RC;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 40-gon approximating a circle — same shape every test uses. */
function circlePoints(cx, cy, r, n = 40) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return pts;
}

function solidRGBA(w, h, [r, g, b], a = 255) {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r; buf[i * 4 + 1] = g; buf[i * 4 + 2] = b; buf[i * 4 + 3] = a;
  }
  return buf;
}

function px(buf, x, y, w) {
  const i = (y * w + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]];
}

/* ------------------------------------------------------------------ PNG */

test('PNG encoder: magic bytes + roundtrip through decoder', () => {
  const w = 13; const h = 7;
  const src = solidRGBA(w, h, [200, 100, 50]);
  const png = encodePNG(w, h, src);
  assert.ok(png.length > 8);
  assert.ok(Buffer.from(png.subarray(0, 8)).equals(PNG_MAGIC), 'PNG signature');
  const back = decodePNG(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual(Array.from(back.data), Array.from(src));
});

/* ---------------------------------------------------------------- layers */

test('layers: ensureBase, add (pen), select, unknown id throws, undo removes', () => {
  const core = new RainCanvasCore({ width: 64, height: 64 });
  assert.equal(core.layers.length, 0, 'starts empty');

  const base = core.ensureBase('base · ref plate');
  assert.equal(base.kind, 'base');
  assert.equal(core.layers.length, 1);
  assert.equal(core.activeLayerId, base.id, 'base becomes active when none was');
  assert.equal(core.ensureBase().id, base.id, 'ensureBase is idempotent');

  assert.throws(() => core.addLayer({ kind: 'base' }), /kind/, 'base kind reserved');
  assert.throws(() => core.addLayer({ kind: 'weird' }), /kind/, 'unknown kind rejected');

  const pen = core.addLayer({ name: 'your red-lines', kind: 'pen' });
  assert.equal(pen.kind, 'pen');
  assert.equal(core.activeLayerId, pen.id, 'new layer becomes active');
  assert.equal(core.layers.length, 2);

  core.setActiveLayer(base.id);
  assert.equal(core.activeLayerId, base.id);
  assert.throws(() => core.setActiveLayer('nope'), /no such layer/);

  assert.ok(core.canUndo());
  const rec = core.undo();
  assert.equal(rec.type, 'addLayer');
  assert.equal(core.layers.length, 1, 'undo removes the added layer');
  assert.equal(core.activeLayerId, base.id, 'active falls back to previous');
});

/* ---------------------------------------------------------------- strokes */

test('pen: stroke recorded as vector data and rasterized onto the layer', () => {
  const core = new RainCanvasCore({ width: 64, height: 64 });
  core.ensureBase();
  const pen = core.addLayer({ name: 'red-lines', kind: 'pen' });

  assert.throws(() => core.addStroke(core.layers[0].id, {
    points: [{ x: 1, y: 1 }], color: '#e07856', width: 3,
  }), /locked/, 'base layer refuses strokes');

  const stroke = core.addStroke(pen.id, {
    points: [{ x: 10, y: 32 }, { x: 30, y: 32 }, { x: 50, y: 32 }],
    color: '#e07856',
    width: 3,
  });
  assert.equal(pen.strokes.length, 1, 'stroke stored');
  assert.equal(stroke.points.length, 3, 'vector points preserved');
  assert.equal(stroke.color, '#e07856');
  assert.equal(stroke.width, 3);
  assert.deepEqual(stroke.points[1], { x: 30, y: 32 });

  // rasterized: non-transparent pixels exist on the stroke line, none far away
  const buf = core.getLayerBuffer(pen.id).data;
  let lit = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) lit += 1;
  assert.ok(lit > 40, `stroke painted (${lit} px)`);
  assert.deepEqual(px(buf, 30, 32, 64).slice(0, 3), [0xe0, 0x78, 0x56], 'coral color painted');
  assert.equal(px(buf, 30, 8, 64)[3], 0, 'far pixel untouched');

  // undo removes the vector stroke AND its pixels
  core.undo();
  assert.equal(pen.strokes.length, 0);
  const after = core.getLayerBuffer(pen.id).data;
  for (let i = 3; i < after.length; i += 4) assert.equal(after[i], 0, 'layer clear after undo');
});

/* ------------------------------------------------------- mask/region export */

test('gen export: PNG magic, dims %8, white-inside/black-outside mask, region pixels match', () => {
  const W = 128; const H = 128;
  const core = new RainCanvasCore({ width: W, height: H });
  const base = core.ensureBase();
  core.setLayerBuffer(base.id, solidRGBA(W, H, [0x12, 0x34, 0x56]));

  const pts = circlePoints(64, 64, 30);
  core.beginLasso();
  for (const p of pts) core.extendLasso(p);
  assert.ok(core.closeLasso(), 'circle lasso closes');

  const assets = core.exportGenAssets({ feather: 24 });
  const { region, regionPng, maskPng } = assets;

  assert.ok(Buffer.from(regionPng.subarray(0, 8)).equals(PNG_MAGIC), 'region PNG magic');
  assert.ok(Buffer.from(maskPng.subarray(0, 8)).equals(PNG_MAGIC), 'mask PNG magic');

  const regionImg = decodePNG(regionPng);
  const maskImg = decodePNG(maskPng);
  assert.equal(regionImg.width % 8, 0, `region width ${regionImg.width} %8`);
  assert.equal(regionImg.height % 8, 0, `region height ${regionImg.height} %8`);
  assert.equal(maskImg.width, regionImg.width, 'mask/region same width');
  assert.equal(maskImg.height, regionImg.height, 'mask/region same height');
  assert.equal(regionImg.width, region.w);
  assert.equal(regionImg.height, region.h);

  // mask: lasso center ~white, corner black (white-on-black for LoadImageMask)
  const cx = 64 - region.x; const cy = 64 - region.y;
  const centerMask = px(maskImg.data, Math.floor(cx), Math.floor(cy), maskImg.width);
  assert.ok(centerMask[0] > 240, `mask center white (${centerMask[0]})`);
  const corner = px(maskImg.data, 1, 1, maskImg.width);
  assert.equal(corner[0], 0, 'mask corner black');
  assert.equal(corner[1], 0, 'mask green channel black too');
  assert.equal(corner[2], 0, 'mask blue channel black too');

  // region: cropped copy of the composite (solid base here)
  const centerRegion = px(regionImg.data, Math.floor(cx), Math.floor(cy), regionImg.width);
  assert.deepEqual(centerRegion, [0x12, 0x34, 0x56, 255], 'region pixel equals canvas pixel');
  const at = px(regionImg.data, 3, 3, regionImg.width);
  const gx = region.x + 3; const gy = region.y + 3;
  assert.deepEqual(at, [0x12, 0x34, 0x56, 255], `region (${3},${3}) maps canvas (${gx},${gy})`);
});

test('gen export without a lasso uses the whole canvas (%8 dims)', () => {
  const core = new RainCanvasCore({ width: 100, height: 60 });
  core.ensureBase();
  const assets = core.exportGenAssets({ feather: 24 });
  assert.equal(assets.regionPng.length > 8, true);
  const img = decodePNG(assets.regionPng);
  assert.equal(img.width % 8, 0);
  assert.equal(img.height % 8, 0);
  assert.ok(img.width >= 100 && img.height >= 60, 'covers whole canvas');
});

/* ---------------------------------------------------------------- commit */

test('commit: ONLY inside-lasso pixels change; outside byte-identical; undo restores exactly', () => {
  const W = 64; const H = 64;
  const core = new RainCanvasCore({ width: W, height: H });
  const base = core.ensureBase();
  core.setLayerBuffer(base.id, solidRGBA(W, H, [10, 20, 30]));
  core.setActiveLayer(base.id); // commit target

  const pts = circlePoints(32, 32, 14);
  core.beginLasso();
  for (const p of pts) core.extendLasso(p);
  assert.ok(core.closeLasso());

  const assets = core.exportGenAssets({ feather: 4 }); // small feather → RW/RH=40 (%8)
  const { region } = assets;
  assert.equal(region.w % 8, 0);
  assert.equal(region.h % 8, 0);

  // take: solid red, same size as region
  const take = solidRGBA(region.w, region.h, [255, 0, 0]);
  core.beginTakeSession(assets);
  core.pushTake(take);

  // independent inside/outside classification (binary fill of the same polygon)
  const inside = scanlineFill(pts, 0, 0, W, H, new Uint8Array(W * H));
  assert.equal(inside[3 * W + 3], 0, 'far corner classified outside (sanity)');
  assert.equal(inside[32 * W + 32], 1, 'center classified inside (sanity)');

  const before = new Uint8ClampedArray(core.getLayerBuffer(base.id).data);

  assert.ok(core.commitTake(), 'commit succeeds');

  const after = core.getLayerBuffer(base.id).data;
  let changedInside = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const samePixel = before[i] === after[i] && before[i + 1] === after[i + 1] &&
        before[i + 2] === after[i + 2] && before[i + 3] === after[i + 3];
      if (inside[y * W + x] === 0) {
        assert.ok(samePixel, `outside pixel (${x},${y}) byte-identical`);
      } else if (!samePixel) {
        changedInside += 1;
      }
    }
  }
  assert.ok(changedInside > 50, `inside pixels changed (${changedInside})`);
  assert.deepEqual(px(after, 32, 32, W), [255, 0, 0, 255], 'deep-inside pixel = take color (cov 1)');
  assert.equal(core.session, null, 'session closed after commit');

  // undo restores the exact prior bytes
  const rec = core.undo();
  assert.equal(rec.type, 'commit');
  const restored = core.getLayerBuffer(base.id).data;
  for (let i = 0; i < before.length; i++) {
    assert.equal(restored[i], before[i], `undo restores byte ${i}`);
  }
  // undo resurrects the session + lasso so the owner can re-commit another take
  assert.ok(core.currentTake(), 'take session restored by undo');
  assert.equal(core.lasso && core.lasso.closed, true, 'lasso restored by undo');
});

/* ------------------------------------------------------------ take stack */

test('take stack: re-GEN pushes, prev/next cycle, discard clears session+lasso', () => {
  const core = new RainCanvasCore({ width: 64, height: 64 });
  const base = core.ensureBase();
  core.setLayerBuffer(base.id, solidRGBA(64, 64, [5, 5, 5]));

  const pts = circlePoints(32, 32, 12);
  core.beginLasso();
  for (const p of pts) core.extendLasso(p);
  core.closeLasso();

  const assets = core.exportGenAssets({ feather: 4 });
  core.beginTakeSession(assets);

  // two "regens" with the same lasso continue the same session (take stack)
  core.pushTake(solidRGBA(assets.region.w, assets.region.h, [255, 0, 0]));
  core.beginTakeSession(core.exportGenAssets({ feather: 4 })); // ⟳ re-run
  assert.equal(core.session.takes.length, 1, 'same lasso+region keeps the take stack');
  core.pushTake(solidRGBA(assets.region.w, assets.region.h, [0, 255, 0]));
  assert.equal(core.session.takes.length, 2);
  assert.equal(core.session.takeIndex, 1, 'newest take active');

  assert.ok(core.prevTake(), 'prev take');
  assert.equal(core.session.takeIndex, 0);
  assert.equal(core.nextTake(), core.session.takes[1], 'next take returns to newest');
  assert.equal(
    core.prevTake().length,
    core.session.region.w * core.session.region.h * 4,
    'take buffer is region-sized',
  );
  assert.ok(core.nextTake(), 'back to newest');
  assert.equal(core.nextTake(), null, 'no next past newest');
  const s = core.session;
  core.prevTake();
  assert.equal(s.takeIndex, 0);
  assert.equal(core.prevTake(), null, 'no prev past oldest');

  // regression: a RE-DRAWN lasso with an equal point count but different
  // coordinates must NOT continue the old session (identity is geometry,
  // not count) — the take stack resets instead of blending through the
  // stale coverage mask. Runs after the prev/next cycle so that flow keeps
  // its original 2-take stack; discardTakes below then clears this new session.
  const shifted = pts.map((p) => ({ x: p.x + 8, y: p.y + 8 }));
  core.beginLasso();
  for (const p of shifted) core.extendLasso(p);
  core.closeLasso();
  const shiftedAssets = core.exportGenAssets({ feather: 4 });
  core.beginTakeSession(shiftedAssets);
  assert.equal(core.session.takes.length, 0, 'different lasso geometry resets the take session');
  assert.notDeepEqual(core.session.region, assets.region, 'region follows the new lasso');

  core.discardTakes();
  assert.equal(core.session, null, 'discard clears session');
  assert.equal(core.lasso, null, 'discard clears lasso');
  assert.equal(core.currentTake(), null);
  assert.equal(core.activeLayer().id, base.id, 'active layer untouched by discard');
});

test('reversed-point lasso with identical region rect still resets the session (coordinate identity is the sole discriminator)', () => {
  const core = new RainCanvasCore({ width: 64, height: 64 });
  const base = core.ensureBase();
  core.setLayerBuffer(base.id, solidRGBA(64, 64, [5, 5, 5]));

  const pts = circlePoints(32, 32, 12);
  core.beginLasso();
  for (const p of pts) core.extendLasso(p);
  core.closeLasso();
  core.beginTakeSession(core.exportGenAssets({ feather: 4 }));
  core.pushTake(solidRGBA(core.session.region.w, core.session.region.h, [255, 0, 0]));
  assert.equal(core.session.takes.length, 1);

  // Same set of points, reversed order: identical bbox → identical %8-padded
  // region rect and identical point COUNT; only the per-index coordinates
  // differ. Count-only identity would wrongly CONTINUE the old session;
  // coordinate identity must reset it.
  const reversed = pts.slice().reverse();
  core.beginLasso();
  for (const p of reversed) core.extendLasso(p);
  core.closeLasso();
  const sameRectAssets = core.exportGenAssets({ feather: 4 });
  assert.deepEqual(
    { x: sameRectAssets.region.x, y: sameRectAssets.region.y, w: sameRectAssets.region.w, h: sameRectAssets.region.h },
    { x: core.session.region.x, y: core.session.region.y, w: core.session.region.w, h: core.session.region.h },
    'precondition: reversed lasso yields the identical region rect',
  );
  core.beginTakeSession(sameRectAssets);
  assert.equal(core.session.takes.length, 0, 'identical count+region but different coordinates resets the session');
  assert.deepEqual(core.session.lassoPoints, reversed, 'new session stores the new geometry');
});

test('commit without a session throws; pushTake size is validated', () => {
  const core = new RainCanvasCore({ width: 32, height: 32 });
  core.ensureBase();
  assert.throws(() => core.commitTake(), /no take to commit/);
  const pts = circlePoints(16, 16, 8);
  core.beginLasso();
  for (const p of pts) core.extendLasso(p);
  core.closeLasso();
  const assets = core.exportGenAssets({ feather: 4 });
  core.beginTakeSession(assets);
  assert.throws(() => core.pushTake(new Uint8ClampedArray(4)), /size mismatch/);
});

/* ------------------------------------------------------------- composite */

test('compositeVisible stacks pen strokes over the base and respects visibility', () => {
  const core = new RainCanvasCore({ width: 32, height: 32 });
  const base = core.ensureBase();
  core.setLayerBuffer(base.id, solidRGBA(32, 32, [0, 0, 255]));
  const pen = core.addLayer({ name: 'red', kind: 'pen' });
  core.addStroke(pen.id, { points: [{ x: 4, y: 16 }, { x: 28, y: 16 }], color: '#e07856', width: 5 });

  let comp = core.compositeVisible().data;
  assert.equal(px(comp, 4, 16, 32)[0], 0xe0, 'stroke visible over base');
  assert.equal(px(comp, 16, 3, 32)[2], 255, 'base visible off-stroke');

  pen.visible = false;
  comp = core.compositeVisible().data;
  assert.deepEqual(px(comp, 4, 16, 32), [0, 0, 255, 255], 'hidden layer skipped');
});
