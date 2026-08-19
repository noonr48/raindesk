'use strict';

/**
 * Immutable server-owned context for Partner animatic pacing advice.
 *
 * The context freezes the project/sequence frame rate plus the exact artwork
 * and bounded Direction Graph state the Partner is allowed to reason over.
 * It carries no panel paths, pixels, worker configuration or approval state.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const contract = require('./animatic-contract');
const ledger = require('./partner-invocation-ledger');
const direction = require('./direction');
const shotDocuments = require('./shot-documents');
const snapshots = require('./animatic-snapshots');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CONTEXT_DIR = path.join(DATA_DIR, 'animatic', 'pacing-contexts');
const SCHEMA_VERSION = 1;
const DIGEST_RE = /^[a-f0-9]{64}$/;

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}
function canonicalJson(value) { return JSON.stringify(canonicalValue(value)); }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function positiveInteger(value, what, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(500, `${what} is invalid`);
  return n;
}

function frameRate(env = process.env) {
  const rawNum = env && env.RAINDESK_ANIMATIC_FPS_NUM;
  const rawDen = env && env.RAINDESK_ANIMATIC_FPS_DEN;
  const fpsNum = rawNum == null || rawNum === '' ? 24 : positiveInteger(rawNum, 'server animatic fps numerator', contract.MAX_FPS_NUM);
  const fpsDen = rawDen == null || rawDen === '' ? 1 : positiveInteger(rawDen, 'server animatic fps denominator', contract.MAX_FPS_DEN);
  return { fpsNum, fpsDen };
}

function parentInvocation(parentRequestId) {
  const id = text(parentRequestId, 96);
  if (!id) throw new HttpError(400, 'parentRequestId is required');
  const row = ledger.find(ledger.read(), id);
  if (!row) throw new HttpError(404, 'no such server-minted animatic proposal');
  if (row.origin !== 'partner_server' || row.adapterId !== 'animatic_timing_v1' ||
      row.capabilityId !== 'animatic_timing' || row.invocationBoundary !== 'external' ||
      row.disposition !== 'proposal' || row.reviewRequired !== true || row.creativeMutation !== true ||
      row.status !== 'proposed' || row.parentRequestId || row.sourceSnapshotDigest ||
      !row.shotId || !row.scope || !row.scope.artRevisionId) {
    throw new HttpError(409, 'parent invocation is not a live coarse animatic Partner proposal');
  }
  return row;
}

function currentRevision(shotId) {
  try {
    const current = shotDocuments.readCurrent(shotId);
    return current && typeof current.revisionId === 'string' && current.revisionId.trim()
      ? current.revisionId.trim() : null;
  } catch (_error) {
    return null;
  }
}

function shotSummary(graph, shot) {
  const beats = (graph.beats || []).filter((beat) => beat && beat.shotId === shot.id && beat.status !== 'rejected')
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  const beatText = beats.slice(0, 8).map((beat) => text(beat.rawDirection || beat.description, 220)).filter(Boolean);
  return {
    shotId: shot.id,
    sceneId: shot.sceneId || null,
    title: text(shot.title, 160),
    description: text(shot.description || shot.purpose, 500),
    beats: beatText,
  };
}

function sequenceIdentity(graph, parentShot) {
  const projectId = text(graph && graph.project && graph.project.id, 160) || 'project';
  if (!contract.CONTRACT_ID_RE.test(projectId)) throw new HttpError(409, 'Direction Graph project id is not valid for the animatic contract');
  const raw = parentShot && parentShot.sceneId ? `scene-${parentShot.sceneId}` : `shot-${parentShot.id}`;
  const sequenceId = text(raw, 160);
  if (!contract.CONTRACT_ID_RE.test(sequenceId)) throw new HttpError(409, 'active scene/shot cannot form a valid animatic sequence id');
  return { projectId, sequenceId };
}

function contextMaterial(parent, env = process.env) {
  const graph = direction.readGraph();
  const parentShot = (graph.shots || []).find((shot) => shot && shot.id === parent.shotId);
  if (!parentShot) throw new HttpError(409, 'parent shot is not present in the Direction Graph');
  const identity = sequenceIdentity(graph, parentShot);
  const rate = frameRate(env);
  const sequenceShots = (graph.shots || []).filter((shot) => shot && shot.status !== 'rejected' &&
    ((parentShot.sceneId && shot.sceneId === parentShot.sceneId) || (!parentShot.sceneId && shot.id === parentShot.id)));

  const eligibleShots = [];
  const unavailableShots = [];
  for (const shot of sequenceShots) {
    const revisionId = currentRevision(shot.id);
    if (!revisionId) {
      unavailableShots.push({ ...shotSummary(graph, shot), reason: 'no_persisted_artwork' });
      continue;
    }
    const creativeStateDigest = snapshots.creativeStateDigest(shot.id);
    eligibleShots.push({
      ...shotSummary(graph, shot),
      artworkRevisionId: revisionId,
      creativeStateDigest,
    });
  }
  const active = eligibleShots.find((shot) => shot.shotId === parent.shotId);
  if (!active) throw new HttpError(409, 'parent shot has no persisted artwork for pacing');
  if (active.artworkRevisionId !== parent.scope.artRevisionId) {
    throw new HttpError(409, 'parent shot artwork changed after the Partner proposal; ask for a fresh proposal');
  }
  if (!eligibleShots.length || eligibleShots.length > contract.MAX_SHOTS) {
    throw new HttpError(409, 'active sequence has no bounded set of pacing-ready shots');
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    parentRequestId: parent.id,
    sourceTurnId: parent.turnId || null,
    projectId: identity.projectId,
    sequenceId: identity.sequenceId,
    fpsNum: rate.fpsNum,
    fpsDen: rate.fpsDen,
    activeShotId: parent.shotId,
    eligibleShots,
    unavailableShots,
  };
}

function contextPath(digest) {
  if (!DIGEST_RE.test(String(digest || ''))) throw new HttpError(400, 'bad pacing context digest');
  return path.join(CONTEXT_DIR, `${digest}.json`);
}

function persist(document) {
  fs.mkdirSync(CONTEXT_DIR, { recursive: true });
  const target = contextPath(document.contextDigest);
  if (fs.existsSync(target)) {
    const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (canonicalJson(existing) !== canonicalJson(document)) throw new HttpError(500, 'pacing context digest collision');
    return { context: existing, created: false };
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  return { context: document, created: true };
}

function create({ parentRequestId, env = process.env } = {}) {
  const parent = parentInvocation(parentRequestId);
  const material = contextMaterial(parent, env);
  const digest = sha256(canonicalJson(material));
  return persist({ ...material, contextDigest: digest });
}

function readByDigest(digest) {
  let context;
  try { context = JSON.parse(fs.readFileSync(contextPath(digest), 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new HttpError(404, 'no such pacing context');
    if (error instanceof SyntaxError) throw new HttpError(500, 'stored pacing context is corrupt');
    throw error;
  }
  const unsigned = { ...context };
  delete unsigned.contextDigest;
  if (context.contextDigest !== digest || sha256(canonicalJson(unsigned)) !== digest) {
    throw new HttpError(500, 'stored pacing context failed integrity verification');
  }
  return context;
}

function freshness(context) {
  const changedShots = [];
  for (const shot of context.eligibleShots || []) {
    const revisionId = currentRevision(shot.shotId);
    let creativeStateDigest = null;
    try { creativeStateDigest = snapshots.creativeStateDigest(shot.shotId); } catch (_error) { /* missing semantic state */ }
    if (revisionId !== shot.artworkRevisionId || creativeStateDigest !== shot.creativeStateDigest) {
      changedShots.push({
        shotId: shot.shotId,
        artworkChanged: revisionId !== shot.artworkRevisionId,
        creativeStateChanged: creativeStateDigest !== shot.creativeStateDigest,
      });
    }
  }
  return { stale: changedShots.length > 0, changedShots };
}

function publicContext(context) {
  const fresh = freshness(context);
  return {
    schemaVersion: context.schemaVersion,
    contextDigest: context.contextDigest,
    parentRequestId: context.parentRequestId,
    sourceTurnId: context.sourceTurnId,
    projectId: context.projectId,
    sequenceId: context.sequenceId,
    fpsNum: context.fpsNum,
    fpsDen: context.fpsDen,
    activeShotId: context.activeShotId,
    eligibleShots: (context.eligibleShots || []).map((shot) => ({
      shotId: shot.shotId,
      sceneId: shot.sceneId,
      title: shot.title,
      description: shot.description,
      beats: shot.beats,
    })),
    unavailableShots: (context.unavailableShots || []).map((shot) => ({
      shotId: shot.shotId,
      title: shot.title,
      reason: shot.reason,
    })),
    stale: fresh.stale,
    changedShots: fresh.changedShots,
  };
}

module.exports = {
  DATA_DIR, CONTEXT_DIR, SCHEMA_VERSION, DIGEST_RE,
  canonicalValue, canonicalJson, sha256, frameRate, parentInvocation,
  currentRevision, shotSummary, sequenceIdentity, contextMaterial, contextPath,
  persist, create, readByDigest, freshness, publicContext,
};
