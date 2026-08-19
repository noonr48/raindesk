'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-animatic-prep-route-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const ledger = require('../partner-invocation-ledger');
const snapshots = require('../animatic-snapshots');
const { createServer } = require('../../server');

function solidPng() {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([25, 50, 75, 255], i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

function seed() {
  const asset = blobs.putPng(solidPng());
  const revision = docs.save('ROUTE_A', {
    schemaVersion: 1, shotId: 'ROUTE_A', canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'route fixture' });
  direction.ensureLegacyShot('ROUTE_A', { title: 'Route A', beat: 'hold then cut' });
  ledger.record({
    id: 'invoke_route_parent', requestId: 'invoke_route_parent', turnId: 'turn_route', shotId: 'ROUTE_A',
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId: 'ROUTE_A', artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'], preserves: [], sideEffects: [], status: 'proposed',
  });
  return revision;
}

async function withServer(t, deps, fn) {
  const server = createServer({ partnerImpl: { turn: async () => ({ reply: 'unused', invocationRequests: [] }) }, ...deps });
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve());
    for (const socket of sockets) socket.destroy();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

test('prepare route uses server rights, returns path-redacted snapshot, and supports digest lookup', async (t) => {
  const revision = seed();
  await withServer(t, { sourceRights: 'server-owned-rights-assertion' }, async (base) => {
    let res = await fetch(`${base}/api/animatic/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentRequestId: 'invoke_route_parent',
        sourceRights: 'browser-forged-rights-ignored',
        snapshot: {
          projectId: 'after-last-rain', sequenceId: 'route-seq', fpsNum: 24, fpsDen: 1, fidelity: 'draft',
          shots: [{ shotId: 'ROUTE_A', revisionId: revision.revisionId, durationFrames: 24 }],
        },
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.invocation.status, 'proposed');
    assert.equal(body.invocation.sourceSnapshotDigest, body.snapshot.snapshot_digest);
    assert.equal(JSON.stringify(body.snapshot).includes(scratch), false);

    const raw = snapshots.read(body.snapshot.snapshot_digest);
    assert.equal(raw.shots[0].source_rights, 'server-owned-rights-assertion');

    res = await fetch(`${base}/api/animatic/snapshot/${body.snapshot.snapshot_digest}`);
    assert.equal(res.status, 200);
    const reread = await res.json();
    assert.equal(reread.snapshot.snapshot_digest, body.snapshot.snapshot_digest);
    assert.equal(JSON.stringify(reread).includes(scratch), false);
  });
});

test('prepare route refuses before touching request data when server source rights are not configured', async (t) => {
  await withServer(t, { sourceRights: null }, async (base) => {
    const res = await fetch(`${base}/api/animatic/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentRequestId: 'does_not_need_to_exist', snapshot: {}, sourceRights: 'browser-cannot-upgrade-this' }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /SOURCE_RIGHTS/i);
  });
});
