'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-server-authority-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const server = require('../../server');

function rgbaPng(width, height, rgba) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(rgba, i * 4);
  return Buffer.from(Canvas.encodePNG(width, height, data));
}

function saveArtwork(shotId) {
  const asset = blobs.putPng(rgbaPng(8, 8, [20, 40, 60, 255]));
  return docs.save(shotId, {
    schemaVersion: 1,
    shotId,
    canvas: { width: 8, height: 8 },
    activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'authority fixture' });
}

test('Partner context overwrites browser artRevisionId with current ShotDocument revision', async () => {
  const revision = saveArtwork('AUTH_SHOT');
  const wrapped = server.withAuthoritativeContext({ turn: async (input) => input });
  const result = await wrapped.turn({
    message: 'make a local edit',
    context: { shotId: 'AUTH_SHOT', artRevisionId: 'browser_forged_revision' },
  });
  assert.equal(result.context.artRevisionId, revision.revisionId);
});

test('unprovable server revision erases browser revision authority instead of trusting it', async () => {
  const wrapped = server.withAuthoritativeContext({ turn: async (input) => input });
  const result = await wrapped.turn({
    message: 'consider this shot',
    context: { shotId: 'NO_SERVER_ART', artRevisionId: 'browser_forged_revision' },
  });
  assert.equal(result.context.artRevisionId, null);
});
