'use strict';

/**
 * Exact-snapshot preparation for the external animatic adapter.
 *
 * A coarse Partner capability request is not execution authority. This module
 * looks up that server-minted parent proposal, compiles an immutable source
 * snapshot, and mints a NEW proposed child invocation whose identity is bound
 * to the snapshot digest. The child still requires explicit approval.
 */

const crypto = require('node:crypto');
const { HttpError } = require('./errors');
const ledger = require('./partner-invocation-ledger');
const snapshots = require('./animatic-snapshots');

const ADAPTER_ID = 'animatic_timing_v1';
const CAPABILITY_ID = 'animatic_timing';

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function parentProposal(id) {
  const key = text(id, 96);
  if (!key) throw new HttpError(400, 'parentRequestId is required');
  const entry = ledger.find(ledger.read(), key);
  if (!entry) throw new HttpError(404, 'no such server-minted parent invocation');
  if (entry.adapterId !== ADAPTER_ID || entry.capabilityId !== CAPABILITY_ID ||
      entry.invocationBoundary !== 'external' || entry.disposition !== 'proposal' ||
      entry.reviewRequired !== true || entry.creativeMutation !== true) {
    throw new HttpError(409, 'parent invocation is not an animatic review proposal');
  }
  if (entry.status !== 'proposed') throw new HttpError(409, 'parent invocation is no longer an unapproved proposal');
  if (entry.sourceSnapshotDigest || entry.parentRequestId) throw new HttpError(409, 'parent invocation is already a prepared child');
  if (!entry.shotId || !entry.scope || !entry.scope.artRevisionId) {
    throw new HttpError(409, 'parent invocation lacks frozen server artwork authority; ask the Partner again after the shot is saved');
  }
  return entry;
}

function childId(parentRequestId, digest) {
  const hash = crypto.createHash('sha256').update(`${parentRequestId}|${digest}`).digest('hex').slice(0, 40);
  return `animatic_${hash}`;
}

function prepare({ parentRequestId, snapshotInput, sourceRights } = {}) {
  const parent = parentProposal(parentRequestId);
  if (!snapshotInput || typeof snapshotInput !== 'object' || Array.isArray(snapshotInput)) {
    throw new HttpError(400, 'snapshot proposal is required');
  }
  const rights = text(sourceRights, 500);
  if (!rights) throw new HttpError(503, 'server source-rights assertion is not configured');
  if (!Array.isArray(snapshotInput.shots)) throw new HttpError(400, 'snapshot proposal shots are required');

  const active = snapshotInput.shots.find((shot) => shot && text(shot.shotId, 96) === parent.shotId);
  if (!active) throw new HttpError(409, 'prepared sequence must include the parent invocation shot');
  if (text(active.revisionId, 160) !== parent.scope.artRevisionId) {
    throw new HttpError(409, 'prepared sequence must use the exact artwork revision frozen by the parent invocation');
  }

  const snapshot = snapshots.compile({ ...snapshotInput, sourceRights: rights });
  const activeSnapshot = snapshot.shots.find((shot) => shot.shot_id === parent.shotId);
  if (!activeSnapshot || activeSnapshot.artwork_revision_id !== parent.scope.artRevisionId) {
    throw new HttpError(409, 'compiled snapshot no longer matches parent artwork authority');
  }

  const id = childId(parent.id, snapshot.snapshot_digest);
  const recorded = ledger.record({
    id,
    requestId: id,
    parentRequestId: parent.id,
    sourceSnapshotDigest: snapshot.snapshot_digest,
    turnId: parent.turnId,
    shotId: parent.shotId,
    adapterId: parent.adapterId,
    capabilityId: parent.capabilityId,
    stageId: parent.stageId,
    recipeId: parent.recipeId,
    invocationBoundary: parent.invocationBoundary,
    disposition: parent.disposition,
    reviewRequired: parent.reviewRequired,
    creativeMutation: parent.creativeMutation,
    scope: parent.scope,
    requiredEvidence: parent.requiredEvidence,
    requiredInputs: parent.requiredInputs,
    expectedOutputs: parent.expectedOutputs,
    preserves: parent.preserves,
    sideEffects: parent.sideEffects,
    status: 'proposed',
  });

  return {
    invocation: recorded.entry,
    created: recorded.created,
    snapshot: snapshots.publicSummary(snapshot),
  };
}

function readPreparedSnapshot(digest) {
  return snapshots.publicSummary(snapshots.read(digest));
}

module.exports = { ADAPTER_ID, CAPABILITY_ID, parentProposal, childId, prepare, readPreparedSnapshot };
