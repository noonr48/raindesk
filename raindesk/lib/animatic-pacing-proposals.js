'use strict';

/**
 * Immutable animatic pacing advice.
 *
 * New production-facing proposals are compiled from a server-owned
 * AnimaticPacingContext. The Partner supplies creative rhythm only: label,
 * rationale, ordered shot ids, frame durations and notes. Project/sequence
 * identity, frame rate, artwork revisions and creative-state bindings come
 * exclusively from the immutable context.
 *
 * The legacy create({parentRequestId, proposal}) helper remains temporarily for
 * existing deterministic tests/internal history; public server routes use
 * createFromContext().
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const invocationLedger = require('./partner-invocation-ledger');
const shotDocuments = require('./shot-documents');
const contract = require('./animatic-contract');
const pacingContexts = require('./animatic-pacing-context');
const snapshots = require('./animatic-snapshots');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const PROPOSAL_DIR = path.join(DATA_DIR, 'animatic', 'pacing-proposals');
const SCHEMA_VERSION = 1;
const ID_RE = contract.CONTRACT_ID_RE;
const FIDELITIES = contract.FIDELITIES;
const MAX_SHOTS = contract.MAX_SHOTS;
const MAX_DURATION_FRAMES = contract.MAX_DURATION_FRAMES;
const TOP_KEYS = new Set(['projectId', 'sequenceId', 'fpsNum', 'fpsDen', 'fidelity', 'label', 'rationale', 'shots']);
const CONTEXT_TOP_KEYS = new Set(['label', 'rationale', 'fidelity', 'shots']);
const SHOT_KEYS = new Set(['shotId', 'durationFrames', 'note']);

function text(value, max = 256) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}
function now() { return new Date().toISOString(); }
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

function assertClosedObject(value, allowed, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, `${what} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new HttpError(400, `${what} contains unsupported field ${extra}`);
  return value;
}
function assertId(value, what) {
  const id = text(value, 256);
  if (!ID_RE.test(id)) throw new HttpError(400, `${what} is invalid`);
  return id;
}
function positiveInteger(value, what, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0 || number > max) throw new HttpError(400, `${what} must be a positive bounded integer`);
  return number;
}
function gcd(a, b) {
  let x = Math.abs(Number(a)); let y = Math.abs(Number(b));
  while (y) { const next = x % y; x = y; y = next; }
  return x || 1;
}
function timeValue(frames, fpsNum, fpsDen) {
  const numerator = frames * fpsDen;
  const denominator = fpsNum;
  const divisor = gcd(numerator, denominator);
  return { num: numerator / divisor, den: denominator / divisor };
}

function normalizeShotTiming(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_SHOTS) {
    throw new HttpError(400, `shots must contain 1..${MAX_SHOTS} ordered items`);
  }
  const seen = new Set();
  return items.map((item, index) => {
    assertClosedObject(item, SHOT_KEYS, `shots[${index}]`);
    const shotId = assertId(item.shotId, `shots[${index}].shotId`);
    if (seen.has(shotId)) throw new HttpError(400, `duplicate shot id ${shotId}`);
    seen.add(shotId);
    return {
      shotId,
      durationFrames: positiveInteger(item.durationFrames, `shots[${index}].durationFrames`, MAX_DURATION_FRAMES),
      note: item.note == null ? null : text(item.note, 800),
    };
  });
}

function parentInvocation(parentRequestId) {
  const id = assertId(parentRequestId, 'parentRequestId');
  const row = invocationLedger.find(invocationLedger.read(), id);
  if (!row) throw new HttpError(404, 'no such server-minted animatic proposal');
  if (row.origin !== 'partner_server' || row.adapterId !== 'animatic_timing_v1' ||
      row.capabilityId !== 'animatic_timing' || row.invocationBoundary !== 'external' ||
      row.disposition !== 'proposal' || row.reviewRequired !== true ||
      row.creativeMutation !== true || row.status !== 'proposed' || row.parentRequestId || row.sourceSnapshotDigest) {
    throw new HttpError(409, 'parent invocation is not a live coarse animatic Partner proposal');
  }
  if (!row.shotId || !row.scope || !row.scope.artRevisionId) throw new HttpError(409, 'parent invocation lacks frozen server artwork authority');
  return row;
}

function normalizeCreative(input) {
  assertClosedObject(input, TOP_KEYS, 'pacing proposal');
  const projectId = assertId(input.projectId, 'projectId');
  const sequenceId = assertId(input.sequenceId, 'sequenceId');
  const fpsNum = positiveInteger(input.fpsNum, 'fpsNum', contract.MAX_FPS_NUM);
  const fpsDen = positiveInteger(input.fpsDen, 'fpsDen', contract.MAX_FPS_DEN);
  const fidelity = text(input.fidelity, 32);
  if (!FIDELITIES.has(fidelity)) throw new HttpError(400, 'fidelity must be draft or preview');
  return {
    projectId, sequenceId, fpsNum, fpsDen, fidelity,
    label: text(input.label, 160), rationale: text(input.rationale, 1200),
    shots: normalizeShotTiming(input.shots),
  };
}

function normalizeContextCreative(input) {
  assertClosedObject(input, CONTEXT_TOP_KEYS, 'pacing proposal');
  const fidelity = input.fidelity == null ? 'draft' : text(input.fidelity, 32);
  if (!FIDELITIES.has(fidelity)) throw new HttpError(400, 'fidelity must be draft or preview');
  return {
    fidelity,
    label: text(input.label, 160),
    rationale: text(input.rationale, 1200),
    shots: normalizeShotTiming(input.shots),
  };
}

function currentRevision(shotId) {
  let current;
  try { current = shotDocuments.readCurrent(shotId); } catch (_error) { current = null; }
  if (!current || typeof current.revisionId !== 'string' || !current.revisionId.trim()) {
    throw new HttpError(409, `shot ${shotId} has no readable persisted artwork revision`);
  }
  return current.revisionId.trim();
}

function bindSourceRevisions(parent, creative) {
  if (!creative.shots.some((item) => item.shotId === parent.shotId)) throw new HttpError(409, 'pacing proposal must include the parent invocation shot');
  const shots = creative.shots.map((item) => ({ ...item, revisionId: currentRevision(item.shotId) }));
  const active = shots.find((item) => item.shotId === parent.shotId);
  if (active.revisionId !== parent.scope.artRevisionId) throw new HttpError(409, 'parent shot artwork changed after the Partner proposal; ask for a fresh pacing proposal');
  return shots;
}

function bindContextSources(context, creative) {
  const freshness = pacingContexts.freshness(context);
  if (freshness.stale) throw new HttpError(409, 'pacing context is stale; ask the Partner for a fresh pacing proposal');
  const eligible = new Map((context.eligibleShots || []).map((shot) => [shot.shotId, shot]));
  if (!creative.shots.some((item) => item.shotId === context.activeShotId)) throw new HttpError(409, 'pacing proposal must include the active context shot');
  return creative.shots.map((item) => {
    const source = eligible.get(item.shotId);
    if (!source) throw new HttpError(409, `shot ${item.shotId} is not eligible in this pacing context`);
    return {
      ...item,
      revisionId: source.artworkRevisionId,
      creativeStateDigest: source.creativeStateDigest,
    };
  });
}

function digestMaterial(parent, creative, boundShots, contextDigest = null) {
  return {
    schemaVersion: SCHEMA_VERSION,
    contextDigest,
    parentRequestId: parent.id,
    sourceTurnId: parent.turnId || null,
    projectId: creative.projectId,
    sequenceId: creative.sequenceId,
    fpsNum: creative.fpsNum,
    fpsDen: creative.fpsDen,
    fidelity: creative.fidelity,
    label: creative.label,
    rationale: creative.rationale,
    shots: boundShots,
  };
}
function proposalPath(digest) {
  if (!/^[a-f0-9]{64}$/.test(String(digest || ''))) throw new HttpError(400, 'bad pacing proposal digest');
  return path.join(PROPOSAL_DIR, `${digest}.json`);
}
function persist(document) {
  fs.mkdirSync(PROPOSAL_DIR, { recursive: true });
  const target = proposalPath(document.proposalDigest);
  if (fs.existsSync(target)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_error) { throw new HttpError(500, 'stored pacing proposal is corrupt'); }
    const existingMaterial = { ...existing }; delete existingMaterial.proposalId; delete existingMaterial.proposalDigest; delete existingMaterial.createdAt;
    const incomingMaterial = { ...document }; delete incomingMaterial.proposalId; delete incomingMaterial.proposalDigest; delete incomingMaterial.createdAt;
    if (canonicalJson(existingMaterial) !== canonicalJson(incomingMaterial)) throw new HttpError(409, 'pacing proposal digest collision with different immutable content');
    return { proposal: existing, created: false };
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(document, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  return { proposal: document, created: true };
}

function create({ parentRequestId, proposal } = {}) {
  const parent = parentInvocation(parentRequestId);
  const creative = normalizeCreative(proposal);
  const boundShots = bindSourceRevisions(parent, creative);
  const material = digestMaterial(parent, creative, boundShots, null);
  const digest = sha256(canonicalJson(material));
  return persist({ ...material, proposalId: `pacing_${digest.slice(0, 40)}`, proposalDigest: digest, createdAt: now() });
}

function createFromContext({ contextDigest, proposal } = {}) {
  const context = pacingContexts.readByDigest(text(contextDigest, 64));
  const parent = parentInvocation(context.parentRequestId);
  if (parent.id !== context.parentRequestId || parent.turnId !== context.sourceTurnId) throw new HttpError(409, 'pacing context parent authority no longer matches');
  const creativeAdvice = normalizeContextCreative(proposal);
  const boundShots = bindContextSources(context, creativeAdvice);
  const creative = {
    projectId: context.projectId,
    sequenceId: context.sequenceId,
    fpsNum: context.fpsNum,
    fpsDen: context.fpsDen,
    fidelity: creativeAdvice.fidelity,
    label: creativeAdvice.label,
    rationale: creativeAdvice.rationale,
    shots: creativeAdvice.shots,
  };
  const material = digestMaterial(parent, creative, boundShots, context.contextDigest);
  const digest = sha256(canonicalJson(material));
  return persist({ ...material, proposalId: `pacing_${digest.slice(0, 40)}`, proposalDigest: digest, createdAt: now() });
}

function readByDigest(digest) {
  let value;
  try { value = JSON.parse(fs.readFileSync(proposalPath(digest), 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new HttpError(404, 'no such pacing proposal');
    if (error instanceof SyntaxError) throw new HttpError(500, 'stored pacing proposal is corrupt');
    throw error;
  }
  if (!value || value.schemaVersion !== SCHEMA_VERSION || value.proposalDigest !== digest) throw new HttpError(500, 'stored pacing proposal is malformed');
  const material = { ...value }; delete material.proposalId; delete material.proposalDigest; delete material.createdAt;
  if (sha256(canonicalJson(material)) !== digest) throw new HttpError(500, 'stored pacing proposal failed integrity verification');
  return value;
}

function freshness(proposal) {
  const changedShots = [];
  let contextChanged = false;
  if (proposal.contextDigest) {
    try {
      const context = pacingContexts.readByDigest(proposal.contextDigest);
      contextChanged = pacingContexts.freshness(context).stale;
    } catch (_error) { contextChanged = true; }
  }
  for (const item of proposal.shots || []) {
    let revision = null; let creativeStateDigest = null;
    try { revision = currentRevision(item.shotId); } catch (_error) { revision = null; }
    if (item.creativeStateDigest) {
      try { creativeStateDigest = snapshots.creativeStateDigest(item.shotId); } catch (_error) { creativeStateDigest = null; }
    }
    const artworkChanged = revision !== item.revisionId;
    const creativeStateChanged = Boolean(item.creativeStateDigest && creativeStateDigest !== item.creativeStateDigest);
    if (artworkChanged || creativeStateChanged) changedShots.push({
      shotId: item.shotId, proposedRevisionId: item.revisionId, currentRevisionId: revision,
      artworkChanged, creativeStateChanged,
    });
  }
  return { stale: contextChanged || changedShots.length > 0, contextChanged, changedShots };
}

function snapshotInput(proposal) {
  return {
    projectId: proposal.projectId, sequenceId: proposal.sequenceId,
    fpsNum: proposal.fpsNum, fpsDen: proposal.fpsDen, fidelity: proposal.fidelity,
    shots: proposal.shots.map((item) => ({ shotId: item.shotId, revisionId: item.revisionId, durationFrames: item.durationFrames })),
  };
}
function publicProposal(proposal) {
  const fresh = freshness(proposal);
  const frameSeconds = proposal.fpsDen / proposal.fpsNum;
  const totalFrames = proposal.shots.reduce((sum, item) => sum + item.durationFrames, 0);
  return {
    schemaVersion: proposal.schemaVersion,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    contextDigest: proposal.contextDigest || null,
    parentRequestId: proposal.parentRequestId,
    sourceTurnId: proposal.sourceTurnId,
    projectId: proposal.projectId,
    sequenceId: proposal.sequenceId,
    fpsNum: proposal.fpsNum,
    fpsDen: proposal.fpsDen,
    fidelity: proposal.fidelity,
    label: proposal.label,
    rationale: proposal.rationale,
    shots: proposal.shots.map((item) => ({
      shotId: item.shotId,
      durationFrames: item.durationFrames,
      durationTime: timeValue(item.durationFrames, proposal.fpsNum, proposal.fpsDen),
      durationSeconds: Math.round(item.durationFrames * frameSeconds * 1000) / 1000,
      note: item.note,
    })),
    totalFrames,
    totalTime: timeValue(totalFrames, proposal.fpsNum, proposal.fpsDen),
    totalSeconds: Math.round(totalFrames * frameSeconds * 1000) / 1000,
    stale: fresh.stale,
    changedShots: fresh.changedShots,
    createdAt: proposal.createdAt,
  };
}

module.exports = {
  DATA_DIR, PROPOSAL_DIR, SCHEMA_VERSION, MAX_SHOTS, MAX_DURATION_FRAMES,
  ID_RE, FIDELITIES, TOP_KEYS, CONTEXT_TOP_KEYS, SHOT_KEYS,
  canonicalValue, canonicalJson, sha256, assertClosedObject, assertId,
  positiveInteger, gcd, timeValue, normalizeShotTiming,
  parentInvocation, normalizeCreative, normalizeContextCreative, currentRevision,
  bindSourceRevisions, bindContextSources, digestMaterial, proposalPath, persist,
  create, createFromContext, readByDigest, freshness, snapshotInput, publicProposal,
};
