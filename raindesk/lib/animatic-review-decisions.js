'use strict';

/**
 * Append-only ReviewDecision@0.2.0 authority for imported animatic candidates.
 *
 * SequenceCandidateManifest stays immutable. This ledger stores the owner's
 * review events separately and derives the current accepted candidate from the
 * event log. Browser-supplied candidate/project/snapshot authority is ignored;
 * identity is resolved from the locally imported candidate record.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const candidates = require('./animatic-candidates');
const snapshots = require('./animatic-snapshots');
const direction = require('./direction');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const LEDGER_PATH = path.join(DATA_DIR, 'animatic', 'review-decisions.json');
const STORE_SCHEMA_VERSION = 1;
const CONTRACT_SCHEMA_VERSION = '0.2.0';
const DECISIONS = new Set(['keep', 'another', 'combine', 'reject']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_DECISIONS = 5000;
const MAX_NOTE = 4096;
const MAX_ANNOTATION_REFS = 256;

function now() { return new Date().toISOString(); }
function emptyStore() {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    decisions: [],
    idempotency: {},
    createdAt: now(),
    updatedAt: now(),
  };
}

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

function atomicWrite(store) {
  fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
  const tmp = `${LEDGER_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, LEDGER_PATH);
}

function read() {
  let raw;
  try { raw = fs.readFileSync(LEDGER_PATH, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') {
      const store = emptyStore();
      atomicWrite(store);
      return store;
    }
    throw error;
  }
  let store;
  try { store = JSON.parse(raw); }
  catch (_error) { throw new HttpError(500, 'animatic review ledger is corrupt'); }
  if (!store || store.schemaVersion !== STORE_SCHEMA_VERSION || !Array.isArray(store.decisions) ||
      !store.idempotency || typeof store.idempotency !== 'object' || Array.isArray(store.idempotency)) {
    throw new HttpError(500, 'animatic review ledger is malformed');
  }
  return store;
}

function write(store) {
  if (store.decisions.length > MAX_DECISIONS) {
    // Review authority is append-only. Do not silently trim history; require a
    // deliberate archival/migration design if the project ever reaches this.
    throw new HttpError(507, 'animatic review ledger reached its v1 decision limit');
  }
  store.updatedAt = now();
  atomicWrite(store);
  return store;
}

function assertId(value, what) {
  const id = text(value, 256);
  if (!ID_RE.test(id)) throw new HttpError(400, `${what} is invalid`);
  return id;
}

function assertDigest(value, what = 'source snapshot digest') {
  const digest = text(value, 64);
  if (!SHA_RE.test(digest)) throw new HttpError(500, `${what} is invalid`);
  return digest;
}

function normalizeAnnotationRefs(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new HttpError(400, 'annotationRefs must be an array');
  const out = [];
  for (const item of value) {
    const id = assertId(item, 'annotation ref');
    if (!out.includes(id)) out.push(id);
    if (out.length > MAX_ANNOTATION_REFS) throw new HttpError(413, 'too many annotation refs');
  }
  return out;
}

function candidateAuthority(candidateId) {
  const record = candidates.read(assertId(candidateId, 'candidateId'));
  const manifest = record && record.candidate;
  if (!manifest || manifest.schema_version !== CONTRACT_SCHEMA_VERSION) {
    throw new HttpError(409, 'candidate is not an imported SequenceCandidateManifest@0.2.0');
  }
  const projectId = manifest.project_id == null ? null : assertId(manifest.project_id, 'candidate project id');
  const sequenceId = manifest.sequence_id == null ? null : assertId(manifest.sequence_id, 'candidate sequence id');
  const digest = assertDigest(manifest.source_snapshot_digest || record.snapshotDigest);
  if (record.snapshotDigest !== digest) throw new HttpError(500, 'candidate record snapshot binding is inconsistent');
  return { record, manifest, projectId, sequenceId, digest };
}

function reviewableAnnotationIds(authority) {
  const snapshot = snapshots.read(authority.digest);
  const ids = new Set();
  for (const shot of snapshot.shots || []) {
    try {
      const spec = direction.shotSpec(shot.shot_id);
      for (const annotation of Array.isArray(spec.annotations) ? spec.annotations : []) {
        if (annotation && annotation.id) ids.add(String(annotation.id));
      }
    } catch (_error) {
      // Snapshot authority remains valid even if a later direction document was
      // removed. Such missing annotations simply cannot be referenced by a new
      // combine decision.
    }
  }
  return ids;
}

function validateAnnotationRefs(authority, decision, refs) {
  if (decision === 'combine' && refs.length === 0) {
    throw new HttpError(400, 'combine requires at least one pinned annotation ref');
  }
  if (!refs.length) return refs;
  const allowed = reviewableAnnotationIds(authority);
  const missing = refs.find((id) => !allowed.has(id));
  if (missing) throw new HttpError(409, `annotation ${missing} is not part of this candidate's source sequence`);
  return refs;
}

function fingerprintInput({ candidateId, decision, note, annotationRefs }) {
  return sha256(canonicalJson({ candidateId, decision, note: note || '', annotationRefs }));
}

function decisionId(candidateId, idempotencyKey) {
  return `review_${sha256(`${candidateId}|${idempotencyKey}`).slice(0, 40)}`;
}

function activeKeep(decisions) {
  const superseded = new Set(decisions.map((item) => item.supersedes_decision_id).filter(Boolean));
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    const item = decisions[i];
    if (item.decision === 'keep' && !superseded.has(item.decision_id)) return item;
  }
  return null;
}

function latestForCandidate(decisions, candidateId) {
  for (let i = decisions.length - 1; i >= 0; i -= 1) {
    if (decisions[i].candidate_id === candidateId) return decisions[i];
  }
  return null;
}

function sequenceDecisions(store, sequenceId) {
  return store.decisions.filter((item) => (item.sequence_id || null) === (sequenceId || null));
}

function chooseSupersedes(store, authority, decision) {
  const scoped = sequenceDecisions(store, authority.sequenceId);
  const keep = activeKeep(scoped);
  if (decision === 'keep') {
    if (keep) return keep.decision_id;
    const latest = latestForCandidate(scoped, authority.manifest.candidate_id);
    return latest ? latest.decision_id : null;
  }
  if (keep && keep.candidate_id === authority.manifest.candidate_id) return keep.decision_id;
  const latest = latestForCandidate(scoped, authority.manifest.candidate_id);
  return latest ? latest.decision_id : null;
}

function append({ candidateId, decision, note = null, annotationRefs = [], idempotencyKey } = {}) {
  const choice = text(decision, 32);
  if (!DECISIONS.has(choice)) throw new HttpError(400, 'decision must be keep, another, combine, or reject');
  const key = text(idempotencyKey, 160);
  if (!IDEMPOTENCY_RE.test(key)) throw new HttpError(400, 'idempotencyKey is required and invalid');
  const cleanNote = note == null ? null : text(note, MAX_NOTE);
  const refs = normalizeAnnotationRefs(annotationRefs);
  const authority = candidateAuthority(candidateId);
  validateAnnotationRefs(authority, choice, refs);

  const store = read();
  const fingerprint = fingerprintInput({
    candidateId: authority.manifest.candidate_id,
    decision: choice,
    note: cleanNote,
    annotationRefs: refs,
  });
  const existing = store.idempotency[key];
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new HttpError(409, 'idempotencyKey was already used for different review content');
    const event = store.decisions.find((item) => item.decision_id === existing.decisionId);
    if (!event) throw new HttpError(500, 'review idempotency index points to a missing decision');
    return { decision: event, created: false, summary: summaryForSequence(store, authority.sequenceId) };
  }

  const supersedes = chooseSupersedes(store, authority, choice);
  const event = {
    schema_version: CONTRACT_SCHEMA_VERSION,
    decision_id: decisionId(authority.manifest.candidate_id, key),
    project_id: authority.projectId,
    sequence_id: authority.sequenceId,
    shot_id: null,
    candidate_id: authority.manifest.candidate_id,
    decision: choice,
    actor_id: 'owner',
    actor_role: 'owner',
    created_at: now(),
    source_snapshot_digest: authority.digest,
    annotation_refs: refs,
    supersedes_decision_id: supersedes,
    note: cleanNote,
    extensions: { raindesk: { review_surface: 'animatic-take-v1' } },
  };
  // Closed-world shared schema sanity guards kept local so a malformed decision
  // can never enter the append-only authority log.
  if (!ID_RE.test(event.decision_id) || !ID_RE.test(event.candidate_id) ||
      (event.project_id !== null && !ID_RE.test(event.project_id)) ||
      (event.sequence_id !== null && !ID_RE.test(event.sequence_id)) ||
      !SHA_RE.test(event.source_snapshot_digest)) {
    throw new HttpError(500, 'server generated an invalid ReviewDecision identity');
  }
  if (event.decision === 'combine' && event.annotation_refs.length === 0) {
    throw new HttpError(500, 'server generated an invalid combine ReviewDecision');
  }

  store.decisions.push(event);
  store.idempotency[key] = { decisionId: event.decision_id, fingerprint };
  write(store);
  return { decision: event, created: true, summary: summaryForSequence(store, authority.sequenceId) };
}

function summaryForSequence(storeOrSequenceId, maybeSequenceId) {
  const store = typeof storeOrSequenceId === 'object' && storeOrSequenceId && Array.isArray(storeOrSequenceId.decisions)
    ? storeOrSequenceId : read();
  const sequenceId = store === storeOrSequenceId ? maybeSequenceId : storeOrSequenceId;
  const scoped = sequenceDecisions(store, sequenceId || null);
  const keep = activeKeep(scoped);
  const latestByCandidate = {};
  for (const event of scoped) latestByCandidate[event.candidate_id] = event;
  return {
    sequenceId: sequenceId || null,
    currentKeepCandidateId: keep ? keep.candidate_id : null,
    currentKeepDecisionId: keep ? keep.decision_id : null,
    latestDecisionId: scoped.length ? scoped[scoped.length - 1].decision_id : null,
    latestByCandidate,
    decisionCount: scoped.length,
  };
}

function summaryForCandidate(candidateId) {
  const authority = candidateAuthority(candidateId);
  const summary = summaryForSequence(authority.sequenceId);
  const latest = summary.latestByCandidate[authority.manifest.candidate_id] || null;
  return {
    candidateId: authority.manifest.candidate_id,
    sequenceId: authority.sequenceId,
    latestDecision: latest,
    isCurrentKeep: summary.currentKeepCandidateId === authority.manifest.candidate_id,
    currentKeepCandidateId: summary.currentKeepCandidateId,
  };
}

function list({ sequenceId = null, candidateId = null, limit = 500 } = {}) {
  const store = read();
  let rows = store.decisions.slice();
  if (sequenceId !== null) rows = rows.filter((item) => (item.sequence_id || null) === sequenceId);
  if (candidateId !== null) rows = rows.filter((item) => item.candidate_id === candidateId);
  const bounded = Math.max(1, Math.min(2000, Number(limit) || 500));
  return rows.slice(-bounded);
}

module.exports = {
  DATA_DIR, LEDGER_PATH, STORE_SCHEMA_VERSION, CONTRACT_SCHEMA_VERSION,
  DECISIONS, ID_RE, IDEMPOTENCY_RE, SHA_RE, MAX_DECISIONS, MAX_NOTE, MAX_ANNOTATION_REFS,
  canonicalValue, canonicalJson, read, write, candidateAuthority,
  reviewableAnnotationIds, validateAnnotationRefs, fingerprintInput, decisionId,
  activeKeep, latestForCandidate, sequenceDecisions, chooseSupersedes,
  append, summaryForSequence, summaryForCandidate, list,
};
