'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-pacing-context-'));
process.env.RAINDESK_DATA_DIR = scratch;

const Canvas = require('../../public/js/canvas');
const blobs = require('../blobs');
const docs = require('../shot-documents');
const direction = require('../direction');
const ledger = require('../partner-invocation-ledger');
const contexts = require('../animatic-pacing-context');
const pacing = require('../animatic-pacing-proposals');

function saveShot(shotId, value, beat) {
  const data = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < 64; i++) data.set([value, value + 1, value + 2, 255], i * 4);
  const asset = blobs.putPng(Buffer.from(Canvas.encodePNG(8, 8, data)));
  const revision = docs.save(shotId, {
    schemaVersion: 1, shotId, canvas: { width: 8, height: 8 }, activeLayerId: 'L1',
    layers: [{ id: 'L1', name: 'base', kind: 'base', visible: true, order: 0, strokes: [], assetSha: asset.sha }],
  }, { reason: 'pacing context fixture' });
  direction.ensureLegacyShot(shotId, { title: shotId, beat });
  return revision;
}

function parent(id, shotId, revisionId) {
  return ledger.record({
    id, requestId: id, origin: 'partner_server', turnId: `turn_${id}`, shotId,
    adapterId: 'animatic_timing_v1', capabilityId: 'animatic_timing',
    stageId: 'animatic_pass:2:animatic_timing', recipeId: 'animatic_pass',
    invocationBoundary: 'external', disposition: 'proposal', reviewRequired: true, creativeMutation: true,
    scope: { shotId, artRevisionId: revisionId, selectionFingerprint: null, selectionStable: null },
    requiredEvidence: ['shot_scope'], requiredInputs: ['SequenceSourceSnapshot@0.2.0'],
    expectedOutputs: ['SequenceCandidateManifest@0.2.0'], status: 'proposed',
  }).entry;
}

test('server-owned pacing context freezes project/frame rate, artwork and creative-state identity', () => {
  const a = saveShot('CTX_A', 20, 'wide descent');
  saveShot('CTX_B', 50, 'hold on reaction');
  const p = parent('invoke_context_a', 'CTX_A', a.revisionId);

  const first = contexts.create({ parentRequestId: p.id, env: { RAINDESK_ANIMATIC_FPS_NUM: '24000', RAINDESK_ANIMATIC_FPS_DEN: '1001' } });
  const second = contexts.create({ parentRequestId: p.id, env: { RAINDESK_ANIMATIC_FPS_NUM: '24000', RAINDESK_ANIMATIC_FPS_DEN: '1001' } });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.context.contextDigest, second.context.contextDigest);
  assert.equal(first.context.projectId, 'project');
  assert.equal(first.context.sequenceId, 'scene-legacy_board');
  assert.equal(first.context.fpsNum, 24000);
  assert.equal(first.context.fpsDen, 1001);
  assert.equal(first.context.eligibleShots.length, 2);
  assert.deepEqual(first.context.eligibleShots.map((s) => s.shotId), ['CTX_A', 'CTX_B']);
  assert.ok(first.context.eligibleShots.every((s) => /^rev_/.test(s.artworkRevisionId)));
  assert.ok(first.context.eligibleShots.every((s) => /^[a-f0-9]{64}$/.test(s.creativeStateDigest)));
  const publicView = contexts.publicContext(first.context);
  assert.equal(JSON.stringify(publicView).includes('artworkRevisionId'), false);
  assert.equal(JSON.stringify(publicView).includes(scratch), false);
  assert.equal(publicView.stale, false);
});

test('context-backed Partner advice cannot replace project, frame-rate or source revision authority', () => {
  const a = saveShot('CTX_C', 80, 'establish');
  saveShot('CTX_D', 100, 'reaction');
  const p = parent('invoke_context_c', 'CTX_C', a.revisionId);
  const ctx = contexts.create({ parentRequestId: p.id }).context;

  const proposal = pacing.createFromContext({
    contextDigest: ctx.contextDigest,
    proposal: {
      label: 'restrained', rationale: 'let it breathe', fidelity: 'draft',
      shots: [
        { shotId: 'CTX_C', durationFrames: 48, note: 'establish' },
        { shotId: 'CTX_D', durationFrames: 24, note: 'reaction' },
      ],
    },
  }).proposal;
  assert.equal(proposal.contextDigest, ctx.contextDigest);
  assert.equal(proposal.projectId, ctx.projectId);
  assert.equal(proposal.sequenceId, ctx.sequenceId);
  assert.equal(proposal.fpsNum, ctx.fpsNum);
  assert.equal(proposal.fpsDen, ctx.fpsDen);
  assert.ok(proposal.shots.every((shot) => shot.revisionId));
  assert.ok(proposal.shots.every((shot) => shot.creativeStateDigest));

  assert.throws(() => pacing.createFromContext({
    contextDigest: ctx.contextDigest,
    proposal: {
      projectId: 'forged', label: 'bad', rationale: '', fidelity: 'draft',
      shots: [{ shotId: 'CTX_C', durationFrames: 24 }],
    },
  }), /unsupported field projectId/);
  assert.throws(() => pacing.createFromContext({
    contextDigest: ctx.contextDigest,
    proposal: {
      label: 'bad', rationale: '', fidelity: 'draft',
      shots: [{ shotId: 'CTX_C', durationFrames: 24, revisionId: 'forged' }],
    },
  }), /unsupported field revisionId/);
});

test('artwork or Direction Graph changes stale context and proposals derived from it', () => {
  const a = saveShot('CTX_STALE_A', 120, 'hold');
  const p = parent('invoke_context_stale', 'CTX_STALE_A', a.revisionId);
  const ctx = contexts.create({ parentRequestId: p.id }).context;
  const proposal = pacing.createFromContext({
    contextDigest: ctx.contextDigest,
    proposal: { label: 'hold', rationale: '', shots: [{ shotId: 'CTX_STALE_A', durationFrames: 24 }] },
  }).proposal;

  direction.createBeat({ shotId: 'CTX_STALE_A', rawDirection: 'new beat after advice', description: 'new beat after advice' });
  assert.equal(contexts.freshness(ctx).stale, true);
  const fresh = pacing.freshness(proposal);
  assert.equal(fresh.stale, true);
  assert.equal(fresh.changedShots[0].creativeStateChanged, true);

  assert.throws(() => pacing.createFromContext({
    contextDigest: ctx.contextDigest,
    proposal: { label: 'late', rationale: '', shots: [{ shotId: 'CTX_STALE_A', durationFrames: 12 }] },
  }), /context is stale/);
});

test('context excludes unsaved sibling shots but never the authoritative parent shot', () => {
  const a = saveShot('CTX_READY', 160, 'ready');
  direction.ensureLegacyShot('CTX_UNSAVED', { title: 'unsaved', beat: 'idea only' });
  const p = parent('invoke_context_ready', 'CTX_READY', a.revisionId);
  const ctx = contexts.create({ parentRequestId: p.id }).context;
  assert.ok(ctx.eligibleShots.some((shot) => shot.shotId === 'CTX_READY'));
  assert.ok(ctx.unavailableShots.some((shot) => shot.shotId === 'CTX_UNSAVED' && shot.reason === 'no_persisted_artwork'));
});
