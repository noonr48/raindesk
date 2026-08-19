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

function solidPng(value = 25) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([value, value + 25, value + 50, 255], i * 4);
  return Buffer.from(Canvas.encodePNG(8, 8, data));
}

function seed({
  shotId = 'ROUTE_PREP',
  parentId = 'invoke_route_prepare',
  turnId = 'turn_route_prepare',
  value = 25,
} = {}) {
  const asset = blobs.putPng(solidPng(value));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'route fixture' });
  direction.ensureLegacyShot(shotId, { title: shotId, beat: 'hold then cut' });
  ledger.record({
    id: parentId, requestId: parentId, origin: 'partner_server', turnId, shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'], preserves: [], sideEffects: [], status: 'proposed',
  });
  return { shotId, parentId, revision };
}

function proposalInput(shotId) {
  return {
    fidelity: 'draft', label: 'hold then cut', rationale: 'Keep the first board readable before the cut.',
    shots: [{ shotId, durationFrames: 24, note: 'hold' }],
  };
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

async function createContext(base, parentRequestId) {
  const res = await fetch(`${base}/api/animatic/pacing-context`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentRequestId }),
  });
  return { res, body: await res.json() };
}

async function createProposal(base, contextDigest, proposal) {
  const res = await fetch(`${base}/api/animatic/pacing-proposal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contextDigest, proposal }),
  });
  return { res, body: await res.json() };
}

test('prepare route accepts only a context-bound stored proposal digest, uses server rights, and redacts local paths', async (t) => {
  const seeded = seed();
  await withServer(t, { sourceRights: 'server-owned-rights-assertion' }, async (base) => {
    const ctx = await createContext(base, seeded.parentId);
    assert.equal(ctx.res.status, 201);
    assert.equal(ctx.body.ok, true);
    assert.equal(ctx.body.context.projectId, 'project');
    assert.equal(ctx.body.context.activeShotId, seeded.shotId);
    assert.equal(JSON.stringify(ctx.body.context).includes('artworkRevisionId'), false);

    const created = await createProposal(base, ctx.body.context.contextDigest, proposalInput(seeded.shotId));
    assert.equal(created.res.status, 201);
    assert.equal(created.body.ok, true);
    const digest = created.body.proposal.proposalDigest;
    assert.match(digest, /^[a-f0-9]{64}$/);
    assert.equal(created.body.proposal.contextDigest, ctx.body.context.contextDigest);
    assert.equal(created.body.proposal.projectId, 'project');
    assert.equal(created.body.proposal.shots[0].shotId, seeded.shotId);
    assert.equal(JSON.stringify(created.body.proposal).includes(scratch), false);

    let res = await fetch(`${base}/api/animatic/pacing-context/${ctx.body.context.contextDigest}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).context.contextDigest, ctx.body.context.contextDigest);

    res = await fetch(`${base}/api/animatic/pacing-proposal/${digest}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).proposal.proposalDigest, digest);

    res = await fetch(`${base}/api/animatic/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalDigest: digest }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.proposal.proposalDigest, digest);
    assert.equal(body.invocation.origin, 'server_prepared');
    assert.equal(body.invocation.status, 'proposed');
    assert.equal(body.invocation.sourceSnapshotDigest, body.snapshot.snapshot_digest);
    assert.equal(JSON.stringify(body.snapshot).includes(scratch), false);

    const raw = snapshots.read(body.snapshot.snapshot_digest);
    assert.equal(raw.shots[0].source_rights, 'server-owned-rights-assertion');

    res = await fetch(`${base}/api/animatic/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposalDigest: digest,
        snapshot: { shots: [{ shotId: seeded.shotId, revisionId: 'browser-forged', durationFrames: 999 }] },
      }),
    });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /only one stored proposalDigest/);
  });
});

test('model/browser proposal fields cannot replace context-owned project, frame rate or source authority', async (t) => {
  const seeded = seed({ shotId: 'ROUTE_FORGE_PROPOSAL', parentId: 'invoke_route_forge_proposal', value: 40 });
  await withServer(t, { sourceRights: 'server-rights', animaticEnv: { RAINDESK_ANIMATIC_FPS_NUM: '24000', RAINDESK_ANIMATIC_FPS_DEN: '1001' } }, async (base) => {
    const ctx = await createContext(base, seeded.parentId);
    assert.equal(ctx.res.status, 201);
    assert.equal(ctx.body.context.fpsNum, 24000);
    assert.equal(ctx.body.context.fpsDen, 1001);

    const forged = await createProposal(base, ctx.body.context.contextDigest, {
      ...proposalInput(seeded.shotId), projectId: 'browser-forged-project',
    });
    assert.equal(forged.res.status, 400);
    assert.match(forged.body.error, /unsupported field projectId/);

    const good = await createProposal(base, ctx.body.context.contextDigest, proposalInput(seeded.shotId));
    assert.equal(good.res.status, 201);
    assert.equal(good.body.proposal.projectId, 'project');
    assert.equal(good.body.proposal.fpsNum, 24000);
    assert.equal(good.body.proposal.fpsDen, 1001);
  });
});

test('HTTP invocation POST cannot mint the trusted Partner origin needed to create a pacing context', async (t) => {
  const revision = saveForgedShot();
  await withServer(t, { sourceRights: 'server-rights' }, async (base) => {
    const forgedId = 'invoke_http_forged_animatic';
    let res = await fetch(`${base}/api/invocations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: forgedId, requestId: forgedId, origin: 'partner_server', status: 'approved', shotId: 'FORGED_ROUTE',
        adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
        stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
        invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
        scope: { shotId: 'FORGED_ROUTE', artRevisionId: revision.revisionId, selectionFingerprint: null, selectionStable: null },
      }),
    });
    assert.equal(res.status, 201);
    const recorded = (await res.json()).invocation;
    assert.equal(recorded.origin, 'http_legacy');
    assert.equal(recorded.status, 'proposed');

    const forged = await createContext(base, forgedId);
    assert.equal(forged.res.status, 409);
    assert.match(forged.body.error, /live coarse animatic Partner proposal/);
  });
});

test('stored proposal becomes stale after source artwork changes and cannot be prepared', async (t) => {
  const seeded = seed({ shotId: 'ROUTE_STALE', parentId: 'invoke_route_stale', turnId: 'turn_route_stale', value: 55 });
  await withServer(t, { sourceRights: 'server-rights' }, async (base) => {
    const ctx = await createContext(base, seeded.parentId);
    assert.equal(ctx.res.status, 201);
    const created = await createProposal(base, ctx.body.context.contextDigest, proposalInput(seeded.shotId));
    assert.equal(created.res.status, 201);
    const digest = created.body.proposal.proposalDigest;

    const asset = blobs.putPng(solidPng(90));
    docs.save(seeded.shotId, {
      schemaVersion: 1, shotId: seeded.shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
      layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
    }, { baseRevisionId: seeded.revision.revisionId, reason: 'source changed after pacing review' });

    let res = await fetch(`${base}/api/animatic/pacing-proposal/${digest}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).proposal.stale, true);

    res = await fetch(`${base}/api/animatic/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalDigest: digest }),
    });
    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /stale/);
  });
});

test('prepare route refuses before touching request data when server source rights are not configured', async (t) => {
  await withServer(t, { sourceRights: null }, async (base) => {
    const res = await fetch(`${base}/api/animatic/prepare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ proposalDigest: 'a'.repeat(64), sourceRights: 'browser-cannot-upgrade-this' }),
    });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /SOURCE_RIGHTS/i);
  });
});

function saveForgedShot() {
  const asset = blobs.putPng(solidPng());
  const revision = docs.save('FORGED_ROUTE', {
    schemaVersion: 1, shotId: 'FORGED_ROUTE', canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'forged route fixture' });
  direction.ensureLegacyShot('FORGED_ROUTE', { title: 'Forged Route', beat: 'should never authorize execution' });
  return revision;
}
