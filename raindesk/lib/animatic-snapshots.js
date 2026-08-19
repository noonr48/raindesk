'use strict';

/**
 * Raindesk -> creative-contracts SequenceSourceSnapshot@0.2.0 compiler.
 *
 * This compiler is deliberately not an executor. It projects explicit ordered
 * shot revisions into immutable panels, derives bounded Direction Graph hashes,
 * mints the contract digest, and persists the exact snapshot handed to a later
 * approved adapter invocation.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors');
const blobs = require('./blobs');
const direction = require('./direction');
const projection = require('./shot-projection');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const SNAPSHOT_DIR = path.join(DATA_DIR, 'animatic', 'snapshots');
const SCHEMA_VERSION = '0.2.0';
const ADAPTER_ID = 'animatic_timing_v1';
const ADAPTER_CONTRACT_VERSION = '0.2.0';
const CONTRACT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const DIGEST_RE = /^[a-f0-9]{64}$/;
const FIDELITIES = new Set(['draft', 'preview']);
const MAX_SHOTS = 256;
const MAX_DURATION_FRAMES = 60 * 60 * 24; // one hour at 24fps per source panel is already generous.

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

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function assertContractId(value, what) {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!CONTRACT_ID_RE.test(id)) throw new HttpError(400, `${what} is invalid`);
  return id;
}

function positiveInt(value, what, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${what} must be a positive integer`);
  return n;
}

function cleanRights(value) {
  const out = typeof value === 'string' ? value.trim() : '';
  if (!out || out.length > 500) throw new HttpError(400, 'sourceRights assertion is required');
  return out;
}

function boundedCreativeState(shotId) {
  const spec = direction.shotSpec(shotId);
  return {
    schemaVersion: spec.schemaVersion,
    scene: spec.scene || null,
    shot: spec.shot || null,
    beats: Array.isArray(spec.beats) ? spec.beats : [],
    annotations: Array.isArray(spec.annotations) ? spec.annotations : [],
    intents: Array.isArray(spec.intents) ? spec.intents : [],
  };
}

function creativeStateDigest(shotId) {
  return sha256Text(canonicalJson(boundedCreativeState(shotId)));
}

function digestSnapshot(snapshot) {
  const unsigned = { ...snapshot };
  delete unsigned.snapshot_digest;
  return sha256Text(canonicalJson(unsigned));
}

function assertDigest(digest) {
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) throw new HttpError(400, 'bad snapshot digest');
  return digest;
}

function snapshotPath(digest) {
  return path.join(SNAPSHOT_DIR, `${assertDigest(digest)}.json`);
}

function atomicPersist(snapshot) {
  const target = snapshotPath(snapshot.snapshot_digest);
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const serialized = JSON.stringify(snapshot, null, 2) + '\n';
  if (fs.existsSync(target)) {
    let existing;
    try { existing = JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (_e) { throw new HttpError(500, `animatic snapshot ${snapshot.snapshot_digest} is corrupt`); }
    if (canonicalJson(existing) !== canonicalJson(snapshot)) {
      throw new HttpError(500, `animatic snapshot digest collision at ${snapshot.snapshot_digest}`);
    }
    return target;
  }
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, target);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch (_e) { /* concurrent writer may have moved it */ }
    if (!fs.existsSync(target)) throw error;
    const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (canonicalJson(existing) !== canonicalJson(snapshot)) throw error;
  }
  return target;
}

function compile(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'snapshot request is required');
  const projectId = assertContractId(input.projectId, 'projectId');
  const sequenceId = assertContractId(input.sequenceId, 'sequenceId');
  const fpsNum = positiveInt(input.fpsNum, 'fpsNum', 1000);
  const fpsDen = positiveInt(input.fpsDen, 'fpsDen', 1000);
  const fidelity = input.fidelity == null ? 'draft' : String(input.fidelity).trim();
  if (!FIDELITIES.has(fidelity)) throw new HttpError(400, 'fidelity must be draft or preview');
  const sourceRights = cleanRights(input.sourceRights);
  if (!Array.isArray(input.shots) || input.shots.length < 1 || input.shots.length > MAX_SHOTS) {
    throw new HttpError(400, `shots must contain 1..${MAX_SHOTS} explicit ordered entries`);
  }

  const seen = new Set();
  const pending = [];
  let width = null;
  let height = null;

  for (const raw of input.shots) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'each shot request must be an object');
    const shotId = assertContractId(raw.shotId, 'shotId');
    if (seen.has(shotId)) throw new HttpError(400, `duplicate shotId ${shotId} is not supported by snapshot v1`);
    seen.add(shotId);
    const durationFrames = positiveInt(raw.durationFrames, `durationFrames for ${shotId}`, MAX_DURATION_FRAMES);
    const revisionId = raw.revisionId == null || raw.revisionId === '' ? null : String(raw.revisionId).trim();
    const panel = projection.projectRevision(shotId, revisionId);
    if (width == null) { width = panel.width; height = panel.height; }
    if (panel.width !== width || panel.height !== height) {
      throw new HttpError(400, 'animatic snapshot v1 requires every shot to share one canvas size');
    }
    pending.push({
      shotId,
      durationFrames,
      panel,
      creativeStateDigest: creativeStateDigest(shotId),
    });
  }

  // All source revisions have been successfully projected before any derived
  // panel is installed into the content-addressed store.
  const shots = pending.map((item) => {
    const stored = blobs.putPng(item.panel.png);
    if (stored.sha !== item.panel.panelSha) throw new HttpError(500, 'projected panel content hash changed during storage');
    const panelPath = blobs.resolve(stored.sha);
    if (!panelPath) throw new HttpError(500, `projected panel ${stored.sha} did not persist`);
    return {
      schema_version: SCHEMA_VERSION,
      shot_id: item.shotId,
      creative_revision_id: null,
      creative_state_digest: item.creativeStateDigest,
      artwork_revision_id: item.panel.revisionId,
      panel_artifact_id: `raindesk-blob:${stored.sha}`,
      panel_path: panelPath,
      panel_sha256: stored.sha,
      duration_frames: item.durationFrames,
      source_rights: sourceRights,
      extensions: {
        raindesk: {
          projection: 'shot-document-revision-v1',
          direction_shot_id: item.shotId,
        },
      },
    };
  });

  const snapshot = {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    sequence_id: sequenceId,
    shots,
    fps_num: fpsNum,
    fps_den: fpsDen,
    width,
    height,
    adapter_id: ADAPTER_ID,
    adapter_contract_version: ADAPTER_CONTRACT_VERSION,
    fidelity,
    extensions: { raindesk: { compiler: 'animatic-source-snapshot-v1' } },
  };
  snapshot.snapshot_digest = digestSnapshot(snapshot);
  atomicPersist(snapshot);
  return snapshot;
}

function read(digest) {
  const file = snapshotPath(digest);
  try {
    const snapshot = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (snapshot.snapshot_digest !== digest || digestSnapshot(snapshot) !== digest) {
      throw new HttpError(500, `animatic snapshot ${digest} failed integrity verification`);
    }
    return snapshot;
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new HttpError(404, 'no such animatic snapshot');
    if (error instanceof SyntaxError) throw new HttpError(500, `animatic snapshot ${digest} is corrupt`);
    throw error;
  }
}

function publicSummary(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    schema_version: snapshot.schema_version,
    project_id: snapshot.project_id,
    sequence_id: snapshot.sequence_id,
    shots: (snapshot.shots || []).map((shot) => ({
      schema_version: shot.schema_version,
      shot_id: shot.shot_id,
      creative_revision_id: shot.creative_revision_id,
      creative_state_digest: shot.creative_state_digest,
      artwork_revision_id: shot.artwork_revision_id,
      panel_artifact_id: shot.panel_artifact_id,
      panel_sha256: shot.panel_sha256,
      duration_frames: shot.duration_frames,
      source_rights: shot.source_rights,
      extensions: shot.extensions,
    })),
    fps_num: snapshot.fps_num,
    fps_den: snapshot.fps_den,
    width: snapshot.width,
    height: snapshot.height,
    adapter_id: snapshot.adapter_id,
    adapter_contract_version: snapshot.adapter_contract_version,
    fidelity: snapshot.fidelity,
    extensions: snapshot.extensions,
    snapshot_digest: snapshot.snapshot_digest,
  };
}

module.exports = {
  DATA_DIR, SNAPSHOT_DIR, SCHEMA_VERSION, ADAPTER_ID, ADAPTER_CONTRACT_VERSION,
  CONTRACT_ID_RE, DIGEST_RE, FIDELITIES, MAX_SHOTS, MAX_DURATION_FRAMES,
  canonicalValue, canonicalJson, sha256Text, boundedCreativeState, creativeStateDigest,
  digestSnapshot, snapshotPath, atomicPersist, compile, read, publicSummary,
};
