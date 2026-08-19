'use strict';

/**
 * Import boundary for external SequenceCandidateManifest@0.2.0 results.
 * External run paths are untrusted until contained, parsed, identity-bound and
 * byte/hash checked. Accepted/rejected state intentionally does not live here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const snapshots = require('./animatic-snapshots');
const videoArtifacts = require('./video-artifacts');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const CANDIDATE_DIR = path.join(DATA_DIR, 'animatic', 'candidates');
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const SHA_RE = /^[a-f0-9]{64}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const CANDIDATE_KEYS = new Set([
  'schema_version', 'candidate_id', 'sequence_id', 'project_id', 'attempt_id',
  'source_snapshot_digest', 'fidelity', 'files', 'media', 'provenance', 'rights', 'extensions',
]);
const ATTEMPT_KEYS = new Set([
  'schema_version', 'attempt_id', 'request_id', 'source_snapshot_digest', 'adapter_id',
  'adapter_version', 'engine', 'lifecycle', 'lock_owner', 'parameters', 'started_at',
  'ended_at', 'terminal_status', 'error', 'candidate_refs', 'extensions',
]);

function assertId(value, what) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!ID_RE.test(id)) throw new HttpError(422, `${what} is invalid`);
  return id;
}

function assertSha(value, what) {
  const sha = typeof value === 'string' ? value.trim() : '';
  if (!SHA_RE.test(sha)) throw new HttpError(422, `${what} is invalid`);
  return sha;
}

function assertClosedObject(value, allowed, what) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(422, `${what} must be an object`);
  const extra = Object.keys(value).find((key) => !allowed.has(key));
  if (extra) throw new HttpError(422, `${what} contains unsupported field ${extra}`);
  return value;
}

function realContained(root, candidate, { directChild = false, regularFile = false } = {}) {
  let rootReal;
  let candidateReal;
  try {
    rootReal = fs.realpathSync(root);
    const lstat = fs.lstatSync(candidate);
    if (lstat.isSymbolicLink()) throw new Error('symlink');
    if (regularFile && !lstat.isFile()) throw new Error('not-file');
    candidateReal = fs.realpathSync(candidate);
  } catch (_error) {
    throw new HttpError(422, 'external candidate path is missing or unsafe');
  }
  const relative = path.relative(rootReal, candidateReal);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(422, 'external candidate path escapes the configured run root');
  }
  if (directChild && path.dirname(candidateReal) !== rootReal) {
    throw new HttpError(422, 'external attempt must be a direct child of the configured run root');
  }
  return candidateReal;
}

function readJsonFile(runDir, name) {
  const file = realContained(runDir, path.join(runDir, name), { regularFile: true });
  const stat = fs.statSync(file);
  if (stat.size > MAX_JSON_BYTES) throw new HttpError(413, `${name} is too large`);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_error) { throw new HttpError(422, `${name} is not valid JSON`); }
}

function validateAttempt(attempt, { digest, expectedAttemptId = null } = {}) {
  assertClosedObject(attempt, ATTEMPT_KEYS, 'ExecutionAttempt');
  if (attempt.schema_version !== '0.2.0') throw new HttpError(422, 'ExecutionAttempt schema version mismatch');
  const attemptId = assertId(attempt.attempt_id, 'attempt_id');
  if (expectedAttemptId && attemptId !== expectedAttemptId) throw new HttpError(422, 'executor stdout attempt_id does not match ExecutionAttempt');
  if (assertSha(attempt.source_snapshot_digest, 'attempt source snapshot digest') !== digest) throw new HttpError(422, 'ExecutionAttempt source snapshot does not match approved snapshot');
  if (attempt.adapter_id !== 'animatic_timing_v1') throw new HttpError(422, 'ExecutionAttempt adapter identity mismatch');
  if (attempt.lifecycle !== 'succeeded' || attempt.terminal_status !== 'succeeded') throw new HttpError(422, 'ExecutionAttempt is not a successful terminal attempt');
  if (!Array.isArray(attempt.candidate_refs) || !attempt.candidate_refs.length) throw new HttpError(422, 'ExecutionAttempt has no candidate reference');
  return attemptId;
}

function validateCandidate(candidate, { digest, attemptId, expectedCandidateId = null } = {}) {
  assertClosedObject(candidate, CANDIDATE_KEYS, 'SequenceCandidateManifest');
  if (candidate.schema_version !== '0.2.0') throw new HttpError(422, 'SequenceCandidateManifest schema version mismatch');
  const candidateId = assertId(candidate.candidate_id, 'candidate_id');
  if (expectedCandidateId && candidateId !== expectedCandidateId) throw new HttpError(422, 'executor stdout candidate_id does not match candidate manifest');
  if (candidate.attempt_id !== attemptId) throw new HttpError(422, 'candidate attempt binding mismatch');
  if (assertSha(candidate.source_snapshot_digest, 'candidate source snapshot digest') !== digest) throw new HttpError(422, 'candidate source snapshot does not match approved snapshot');
  if (!candidate.fidelity || !['draft', 'preview'].includes(candidate.fidelity.level)) throw new HttpError(422, 'candidate fidelity is invalid');
  if (!Array.isArray(candidate.files) || candidate.files.length !== 1) throw new HttpError(422, 'animatic candidate v1 requires exactly one artifact file');
  if (!candidate.media || typeof candidate.media !== 'object') throw new HttpError(422, 'candidate media metadata is missing');
  if (!candidate.provenance || typeof candidate.provenance !== 'object') throw new HttpError(422, 'candidate provenance is missing');
  if (!candidate.rights || typeof candidate.rights !== 'object') throw new HttpError(422, 'candidate rights are missing');
  for (const forbidden of ['review_state', 'approval', 'approved', 'accepted', 'reviewDecision', 'review_decision']) {
    if (Object.prototype.hasOwnProperty.call(candidate, forbidden)) throw new HttpError(422, 'candidate manifest illegally carries review state');
  }
  return candidateId;
}

function resolveManifestArtifact(runDir, fileSpec) {
  if (!fileSpec || typeof fileSpec !== 'object' || Array.isArray(fileSpec)) throw new HttpError(422, 'candidate file record is invalid');
  if (fileSpec.mime_type !== 'video/mp4') throw new HttpError(422, 'animatic candidate v1 accepts only video/mp4');
  const relative = typeof fileSpec.path === 'string' ? fileSpec.path.trim() : '';
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]+/).includes('..')) throw new HttpError(422, 'candidate file path is unsafe');
  const file = realContained(runDir, path.resolve(runDir, relative), { regularFile: true });
  const bytes = fs.readFileSync(file);
  const expectedSha = assertSha(fileSpec.sha256, 'candidate file sha256');
  const expectedBytes = Number(fileSpec.bytes);
  if (!Number.isInteger(expectedBytes) || expectedBytes < 0) throw new HttpError(422, 'candidate file byte count is invalid');
  const mirrored = videoArtifacts.putMp4(bytes, { expectedSha, expectedBytes });
  return mirrored;
}

function candidatePath(candidateId) {
  return path.join(CANDIDATE_DIR, `${assertId(candidateId, 'candidate id')}.json`);
}

function persist(record) {
  fs.mkdirSync(CANDIDATE_DIR, { recursive: true });
  const target = candidatePath(record.candidate.candidate_id);
  const serialized = JSON.stringify(record, null, 2) + '\n';
  if (fs.existsSync(target)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (_e) { throw new HttpError(500, 'stored animatic candidate record is corrupt'); }
    if (snapshots.canonicalJson(existing) !== snapshots.canonicalJson(record)) {
      throw new HttpError(409, `candidate id ${record.candidate.candidate_id} already exists with different immutable content`);
    }
    return existing;
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, target);
  return record;
}

function importExternal({ runRoot, runDir, invocationId, snapshotDigest, expectedAttemptId = null, expectedCandidateId = null } = {}) {
  const digest = assertSha(snapshotDigest, 'approved snapshot digest');
  const safeRun = realContained(runRoot, runDir, { directChild: true });
  const internalSnapshot = snapshots.read(digest);
  const copiedSnapshot = readJsonFile(safeRun, 'source-snapshot.json');
  if (snapshots.digestSnapshot(copiedSnapshot) !== digest || snapshots.canonicalJson(copiedSnapshot) !== snapshots.canonicalJson(internalSnapshot)) {
    throw new HttpError(422, 'external copied source snapshot is not byte-semantically identical to Raindesk authority');
  }

  const attempt = readJsonFile(safeRun, 'execution-attempt.json');
  const attemptId = validateAttempt(attempt, { digest, expectedAttemptId });
  const candidate = readJsonFile(safeRun, 'sequence-candidate.json');
  const candidateId = validateCandidate(candidate, { digest, attemptId, expectedCandidateId });
  if (!attempt.candidate_refs.includes(candidateId)) throw new HttpError(422, 'ExecutionAttempt does not reference the returned candidate');
  if (candidate.sequence_id !== internalSnapshot.sequence_id || (candidate.project_id && candidate.project_id !== internalSnapshot.project_id)) {
    throw new HttpError(422, 'candidate project/sequence identity does not match approved snapshot');
  }

  const artifact = resolveManifestArtifact(safeRun, candidate.files[0]);
  const record = {
    schemaVersion: 1,
    invocationId: assertId(invocationId, 'invocation id'),
    snapshotDigest: digest,
    importedAt: new Date().toISOString(),
    attempt,
    candidate,
    artifacts: [{ sha: artifact.sha, bytes: artifact.bytes, mimeType: artifact.mimeType }],
  };
  return persist(record);
}

function read(candidateId) {
  try { return JSON.parse(fs.readFileSync(candidatePath(candidateId), 'utf8')); }
  catch (error) {
    if (error && error.code === 'ENOENT') throw new HttpError(404, 'no such animatic candidate');
    if (error instanceof SyntaxError) throw new HttpError(500, 'stored animatic candidate record is corrupt');
    throw error;
  }
}

function list({ sequenceId = null, projectId = null, limit = 100 } = {}) {
  let names;
  try { names = fs.readdirSync(CANDIDATE_DIR); }
  catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    let record;
    try { record = read(id); }
    catch (_error) { continue; }
    if (sequenceId !== null && (record.candidate.sequence_id || null) !== sequenceId) continue;
    if (projectId !== null && (record.candidate.project_id || null) !== projectId) continue;
    rows.push(record);
  }
  rows.sort((a, b) => String(a.importedAt || '').localeCompare(String(b.importedAt || '')) ||
    String(a.candidate.candidate_id).localeCompare(String(b.candidate.candidate_id)));
  return rows.slice(-Math.max(1, Math.min(500, Number(limit) || 100)));
}

function publicRecord(record) {
  if (!record) return null;
  return {
    schemaVersion: record.schemaVersion,
    invocationId: record.invocationId,
    snapshotDigest: record.snapshotDigest,
    importedAt: record.importedAt,
    attempt: {
      attempt_id: record.attempt.attempt_id,
      adapter_id: record.attempt.adapter_id,
      adapter_version: record.attempt.adapter_version || null,
      lifecycle: record.attempt.lifecycle,
      terminal_status: record.attempt.terminal_status,
      started_at: record.attempt.started_at,
      ended_at: record.attempt.ended_at,
    },
    candidate: record.candidate,
    artifacts: record.artifacts.map((artifact) => ({
      sha: artifact.sha,
      bytes: artifact.bytes,
      mimeType: artifact.mimeType,
      url: `/api/animatic/artifact/${artifact.sha}`,
    })),
  };
}

module.exports = {
  DATA_DIR, CANDIDATE_DIR, ID_RE, SHA_RE, MAX_JSON_BYTES,
  assertId, assertSha, assertClosedObject, realContained, readJsonFile,
  validateAttempt, validateCandidate, resolveManifestArtifact, candidatePath, persist,
  importExternal, read, list, publicRecord,
};
