'use strict';

/**
 * Direction Graph — the structured production memory underneath Raindesk's
 * deliberately messy creative surface.
 *
 * The artist never has to fill this structure out. The Partner incrementally
 * derives it from chat, sketches, arrows, captions, selections and accepted
 * takes. Raw artist wording is preserved beside every interpretation so a
 * later agent/tool never has to guess what the original direction was.
 *
 * Store: data/direction.json (or RAINDESK_DATA_DIR/direction.json in tests).
 * All writes are atomic tmp+rename, matching the existing board/shot stores.
 */

const fs = require('fs');
const path = require('path');
const { HttpError } = require('./errors');

const DATA_DIR = process.env.RAINDESK_DATA_DIR
  ? path.resolve(process.env.RAINDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
const DIRECTION_PATH = path.join(DATA_DIR, 'direction.json');
const SCHEMA_VERSION = 1;
const PARTNER_MODES = ['watch', 'suggest', 'act'];
const ANNOTATION_KINDS = [
  'camera_path', 'actor_motion', 'framing', 'attention', 'timing',
  'dialogue_anchor', 'contact', 'preserve', 'branch', 'note', 'unknown',
];
const STATUS = ['provisional', 'accepted', 'rejected', 'superseded'];
const ID_RE = /^[A-Za-z0-9_-]{1,96}$/;
const TEXT_LIMIT = 16000;
let idSeq = 0;

function now() { return new Date().toISOString(); }

function cleanText(value, max = TEXT_LIMIT) {
  if (value == null) return '';
  const s = String(value).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function makeId(prefix, existing = []) {
  const used = new Set(existing.map((x) => x && x.id).filter(Boolean));
  for (;;) {
    idSeq = (idSeq + 1) % 1679616; // 36^4, plenty for same-ms collisions
    const id = `${prefix}_${Date.now().toString(36)}_${idSeq.toString(36)}`;
    if (!used.has(id)) return id;
  }
}

function emptyGraph() {
  return {
    schemaVersion: SCHEMA_VERSION,
    project: {
      id: 'project',
      title: '',
      creativeState: 'blank',
      partnerMode: 'suggest',
      activeSceneId: null,
      activeShotId: null,
    },
    scenes: [],
    shots: [],
    beats: [],
    annotations: [],
    intents: [],
    decisions: [],
    openQuestions: [],
    createdAt: now(),
    updatedAt: now(),
  };
}

function isObject(v) { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }

function isValidGraph(g) {
  return Boolean(
    isObject(g) && g.schemaVersion === SCHEMA_VERSION && isObject(g.project) &&
    Array.isArray(g.scenes) && Array.isArray(g.shots) && Array.isArray(g.beats) &&
    Array.isArray(g.annotations) && Array.isArray(g.intents) &&
    Array.isArray(g.decisions) && Array.isArray(g.openQuestions),
  );
}

function writeGraph(graph) {
  if (!isValidGraph(graph)) throw new HttpError(500, 'direction graph is malformed');
  graph.updatedAt = now();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DIRECTION_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, DIRECTION_PATH);
  return graph;
}

function readGraph() {
  let raw;
  try {
    raw = fs.readFileSync(DIRECTION_PATH, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      const graph = emptyGraph();
      writeGraph(graph);
      return graph;
    }
    throw e;
  }
  let graph;
  try { graph = JSON.parse(raw); } catch (_e) {
    throw new HttpError(500, 'data/direction.json is not valid JSON');
  }
  if (!isValidGraph(graph)) throw new HttpError(500, 'data/direction.json is malformed');
  return graph;
}

function assertId(id, what = 'id') {
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    throw new HttpError(400, `${what} must be [A-Za-z0-9_-], 1-96 chars`);
  }
  return id;
}

function normalizeStatus(value, fallback = 'provisional') {
  return STATUS.includes(value) ? value : fallback;
}

function setProject(patch = {}) {
  const graph = readGraph();
  if (patch.title !== undefined) graph.project.title = cleanText(patch.title, 512);
  if (patch.creativeState !== undefined) graph.project.creativeState = cleanText(patch.creativeState, 64) || 'blank';
  if (patch.partnerMode !== undefined) {
    if (!PARTNER_MODES.includes(patch.partnerMode)) {
      throw new HttpError(400, `partnerMode must be one of: ${PARTNER_MODES.join(', ')}`);
    }
    graph.project.partnerMode = patch.partnerMode;
  }
  if (patch.activeSceneId !== undefined) graph.project.activeSceneId = patch.activeSceneId || null;
  if (patch.activeShotId !== undefined) graph.project.activeShotId = patch.activeShotId || null;
  return writeGraph(graph);
}

function createScene(input = {}) {
  const graph = readGraph();
  const title = cleanText(input.title, 512);
  const description = cleanText(input.description);
  if (!title && !description) throw new HttpError(400, 'scene needs a title or description');
  const id = input.id ? assertId(input.id, 'scene id') : makeId('scene', graph.scenes);
  if (graph.scenes.some((s) => s.id === id)) throw new HttpError(409, `scene "${id}" already exists`);
  const scene = {
    id,
    title,
    description,
    purpose: cleanText(input.purpose),
    mood: cleanText(input.mood),
    participants: Array.isArray(input.participants) ? input.participants.map((x) => cleanText(x, 256)).filter(Boolean) : [],
    status: normalizeStatus(input.status),
    source: isObject(input.source) ? input.source : { kind: 'user' },
    createdAt: now(),
    updatedAt: now(),
  };
  graph.scenes.push(scene);
  graph.project.activeSceneId = id;
  graph.project.creativeState = graph.shots.length ? 'developing' : 'scene_started';
  writeGraph(graph);
  return scene;
}

function getScene(graph, id) { return graph.scenes.find((s) => s.id === id) || null; }
function getShot(graph, id) { return graph.shots.find((s) => s.id === id) || null; }

function safeLegacyPart(value) {
  const s = cleanText(value, 256).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 72);
  return s || 'shot';
}

/**
 * Bridge the existing storyboard board into Direction Graph scope lazily.
 * This keeps ordinary Partner chat useful before the new scene/shot UI fully
 * replaces the legacy board. The bridge is idempotent and never copies art.
 */
function ensureLegacyShot(legacyShotId, { beat = '', title = '' } = {}) {
  const rawLegacyId = cleanText(legacyShotId, 256);
  if (!rawLegacyId) throw new HttpError(400, 'legacyShotId is required');
  const graph = readGraph();
  const sceneId = 'legacy_board';
  let scene = getScene(graph, sceneId);
  if (!scene) {
    scene = {
      id: sceneId,
      title: 'Working board',
      description: 'Bridge for the current Raindesk storyboard surface.',
      purpose: '', mood: '', participants: [], status: 'provisional',
      source: { kind: 'legacy_board_bridge' },
      createdAt: now(), updatedAt: now(),
    };
    graph.scenes.push(scene);
  }

  let shot = graph.shots.find((item) => item && item.source &&
    item.source.kind === 'legacy_board_bridge' && item.source.legacyShotId === rawLegacyId) || null;
  if (!shot) {
    const shotId = `legacy_${safeLegacyPart(rawLegacyId)}`;
    const occupied = getShot(graph, shotId);
    if (occupied && (!occupied.source || occupied.source.legacyShotId !== rawLegacyId)) {
      throw new HttpError(409, `legacy shot bridge collision for "${rawLegacyId}"`);
    }
    shot = occupied || {
      id: shotId,
      sceneId,
      title: cleanText(title, 512) || rawLegacyId,
      description: cleanText(beat),
      purpose: '', startFrame: null, endFrame: null, camera: {}, dialogue: [],
      preserve: [], takes: [], status: 'provisional',
      source: { kind: 'legacy_board_bridge', legacyShotId: rawLegacyId },
      createdAt: now(), updatedAt: now(),
    };
    if (!occupied) graph.shots.push(shot);
  } else if (!shot.description && beat) {
    shot.description = cleanText(beat);
    shot.updatedAt = now();
  }

  graph.project.activeSceneId = sceneId;
  graph.project.activeShotId = shot.id;
  if (graph.project.creativeState === 'blank' || graph.project.creativeState === 'scene_started') {
    graph.project.creativeState = 'developing';
  }
  writeGraph(graph);
  return { sceneId, shotId: shot.id, scene, shot };
}

function createShot(input = {}) {
  const graph = readGraph();
  const sceneId = assertId(input.sceneId, 'sceneId');
  if (!getScene(graph, sceneId)) throw new HttpError(404, `unknown scene "${sceneId}"`);
  const id = input.id ? assertId(input.id, 'shot id') : makeId('shot', graph.shots);
  if (graph.shots.some((s) => s.id === id)) throw new HttpError(409, `shot "${id}" already exists`);
  const shot = {
    id,
    sceneId,
    title: cleanText(input.title, 512),
    description: cleanText(input.description),
    purpose: cleanText(input.purpose),
    startFrame: isObject(input.startFrame) ? input.startFrame : null,
    endFrame: isObject(input.endFrame) ? input.endFrame : null,
    camera: isObject(input.camera) ? input.camera : {},
    dialogue: Array.isArray(input.dialogue) ? input.dialogue : [],
    preserve: Array.isArray(input.preserve) ? input.preserve.map((x) => cleanText(x, 1000)).filter(Boolean) : [],
    takes: Array.isArray(input.takes) ? input.takes : [],
    status: normalizeStatus(input.status),
    source: isObject(input.source) ? input.source : { kind: 'user' },
    createdAt: now(),
    updatedAt: now(),
  };
  graph.shots.push(shot);
  graph.project.activeSceneId = sceneId;
  graph.project.activeShotId = id;
  graph.project.creativeState = 'developing';
  writeGraph(graph);
  return shot;
}

function normalizeMovement(movement) {
  if (!isObject(movement)) return {};
  const keys = [
    'actor', 'preparation', 'action', 'bodyPart', 'target', 'path', 'quality',
    'timing', 'emotion', 'followThrough', 'cameraRelation', 'sound',
  ];
  const out = {};
  for (const key of keys) {
    if (movement[key] !== undefined) out[key] = cleanText(movement[key], 2000);
  }
  return out;
}

function createBeat(input = {}) {
  const graph = readGraph();
  const shotId = assertId(input.shotId, 'shotId');
  const shot = getShot(graph, shotId);
  if (!shot) throw new HttpError(404, `unknown shot "${shotId}"`);
  const id = input.id ? assertId(input.id, 'beat id') : makeId('beat', graph.beats);
  if (graph.beats.some((b) => b.id === id)) throw new HttpError(409, `beat "${id}" already exists`);
  const siblings = graph.beats.filter((b) => b.shotId === shotId);
  const beat = {
    id,
    shotId,
    order: Number.isFinite(input.order) ? Number(input.order) : siblings.length + 1,
    description: cleanText(input.description),
    rawDirection: cleanText(input.rawDirection || input.description),
    movement: normalizeMovement(input.movement),
    camera: isObject(input.camera) ? input.camera : {},
    timing: isObject(input.timing) ? input.timing : {},
    dialogue: cleanText(input.dialogue),
    preserve: Array.isArray(input.preserve) ? input.preserve.map((x) => cleanText(x, 1000)).filter(Boolean) : [],
    status: normalizeStatus(input.status),
    source: isObject(input.source) ? input.source : { kind: 'user' },
    createdAt: now(),
    updatedAt: now(),
  };
  graph.beats.push(beat);
  writeGraph(graph);
  return beat;
}

function addAnnotation(input = {}) {
  const graph = readGraph();
  const scopeType = ['project', 'scene', 'shot', 'beat', 'canvas_object'].includes(input.scopeType)
    ? input.scopeType : 'project';
  const scopeId = input.scopeId ? assertId(input.scopeId, 'scopeId') : 'project';
  if (scopeType === 'scene' && !getScene(graph, scopeId)) throw new HttpError(404, `unknown scene "${scopeId}"`);
  if (scopeType === 'shot' && !getShot(graph, scopeId)) throw new HttpError(404, `unknown shot "${scopeId}"`);
  if (scopeType === 'beat' && !graph.beats.some((b) => b.id === scopeId)) throw new HttpError(404, `unknown beat "${scopeId}"`);
  const kind = ANNOTATION_KINDS.includes(input.kind) ? input.kind : 'unknown';
  const id = input.id ? assertId(input.id, 'annotation id') : makeId('ann', graph.annotations);
  const annotation = {
    id,
    scopeType,
    scopeId,
    kind,
    rawText: cleanText(input.rawText),
    geometry: isObject(input.geometry) ? input.geometry : null,
    interpretation: isObject(input.interpretation) ? input.interpretation : null,
    confidence: Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, Number(input.confidence))) : null,
    status: normalizeStatus(input.status),
    source: isObject(input.source) ? input.source : { kind: 'user_annotation' },
    createdAt: now(),
    updatedAt: now(),
  };
  graph.annotations.push(annotation);
  writeGraph(graph);
  return annotation;
}

function recordIntent(input = {}) {
  const graph = readGraph();
  const id = input.id ? assertId(input.id, 'intent id') : makeId('intent', graph.intents);
  const intent = {
    id,
    raw: cleanText(input.raw),
    kind: cleanText(input.kind, 128) || 'creative_direction',
    sceneId: input.sceneId || graph.project.activeSceneId || null,
    shotId: input.shotId || graph.project.activeShotId || null,
    interpretation: isObject(input.interpretation) ? input.interpretation : null,
    workflowHints: Array.isArray(input.workflowHints) ? input.workflowHints : [],
    status: normalizeStatus(input.status),
    source: isObject(input.source) ? input.source : { kind: 'partner_turn' },
    createdAt: now(),
  };
  graph.intents.push(intent);
  // Keep the event log useful without allowing an endless local file to grow.
  if (graph.intents.length > 1000) graph.intents.splice(0, graph.intents.length - 1000);
  writeGraph(graph);
  return intent;
}

function summary(graph = readGraph()) {
  const activeScene = graph.project.activeSceneId ? getScene(graph, graph.project.activeSceneId) : null;
  const activeShot = graph.project.activeShotId ? getShot(graph, graph.project.activeShotId) : null;
  const shotBeats = activeShot
    ? graph.beats.filter((b) => b.shotId === activeShot.id).sort((a, b) => a.order - b.order)
    : [];
  const shotAnnotations = activeShot
    ? graph.annotations.filter((a) => a.scopeType === 'shot' && a.scopeId === activeShot.id)
    : [];
  return {
    schemaVersion: graph.schemaVersion,
    project: graph.project,
    counts: {
      scenes: graph.scenes.length,
      shots: graph.shots.length,
      beats: graph.beats.length,
      annotations: graph.annotations.length,
    },
    activeScene,
    activeShot,
    activeBeats: shotBeats.slice(-24),
    activeAnnotations: shotAnnotations.slice(-24),
    recentIntents: graph.intents.slice(-12),
    openQuestions: graph.openQuestions.slice(-12),
  };
}

module.exports = {
  DATA_DIR, DIRECTION_PATH, SCHEMA_VERSION, PARTNER_MODES, ANNOTATION_KINDS,
  STATUS, emptyGraph, isValidGraph, readGraph, writeGraph, setProject,
  createScene, createShot, createBeat, addAnnotation, recordIntent, summary,
  normalizeMovement, ensureLegacyShot, safeLegacyPart,
};
