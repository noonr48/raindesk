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
const SCHEMA_VERSION = 2;
const PARTNER_MODES = ['watch', 'suggest', 'act'];
const ANNOTATION_KINDS = [
  'camera_path', 'actor_motion', 'framing', 'attention', 'timing',
  'dialogue_anchor', 'contact', 'preserve', 'branch', 'note', 'unknown',
];
const STATUS = ['provisional', 'accepted', 'rejected', 'superseded'];
const EVENT_KINDS = ['action', 'performance', 'dialogue', 'camera', 'contact', 'sound'];
const RELATION_KINDS = ['before', 'after', 'during', 'overlaps', 'follows', 'causes', 'simultaneous'];
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
      constraints: [],
      mediums: ['storyboard', 'comic', 'animation'],
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


function migrateV1(input) {
  const graph = input && typeof input === 'object' ? input : emptyGraph();
  graph.project = isObject(graph.project) ? graph.project : emptyGraph().project;
  graph.project.constraints = Array.isArray(graph.project.constraints) ? graph.project.constraints : [];
  graph.project.mediums = Array.isArray(graph.project.mediums) && graph.project.mediums.length
    ? graph.project.mediums : ['storyboard', 'comic', 'animation'];
  graph.scenes = Array.isArray(graph.scenes) ? graph.scenes : [];
  graph.shots = Array.isArray(graph.shots) ? graph.shots : [];
  graph.beats = Array.isArray(graph.beats) ? graph.beats : [];
  graph.annotations = Array.isArray(graph.annotations) ? graph.annotations : [];
  graph.intents = Array.isArray(graph.intents) ? graph.intents : [];
  graph.decisions = Array.isArray(graph.decisions) ? graph.decisions : [];
  graph.openQuestions = Array.isArray(graph.openQuestions) ? graph.openQuestions : [];

  // Rename legacy bridge shots to their actual board/document id when that id
  // is valid and not already occupied. All semantic references move together.
  const occupied = new Set(graph.shots.map((shot) => shot && shot.id).filter(Boolean));
  const renames = new Map();
  for (const shot of graph.shots) {
    if (!shot || !shot.source || shot.source.kind !== 'legacy_board_bridge') continue;
    const legacy = cleanText(shot.source.legacyShotId, 96);
    if (!legacy || !ID_RE.test(legacy) || shot.id === legacy) continue;
    if (occupied.has(legacy)) continue;
    occupied.delete(shot.id); occupied.add(legacy);
    renames.set(shot.id, legacy); shot.id = legacy; shot.updatedAt = now();
  }
  if (renames.size) {
    for (const beat of graph.beats) if (renames.has(beat.shotId)) beat.shotId = renames.get(beat.shotId);
    for (const ann of graph.annotations) {
      if (ann.scopeType === 'shot' && renames.has(ann.scopeId)) ann.scopeId = renames.get(ann.scopeId);
    }
    for (const intent of graph.intents) if (renames.has(intent.shotId)) intent.shotId = renames.get(intent.shotId);
    if (renames.has(graph.project.activeShotId)) graph.project.activeShotId = renames.get(graph.project.activeShotId);
  }

  for (const shot of graph.shots) {
    if (!isObject(shot.cameraCues)) shot.cameraCues = { start: null, end: null };
    if (shot.startFrame === undefined) shot.startFrame = null;
    if (shot.endFrame === undefined) shot.endFrame = null;
  }
  for (const beat of graph.beats) {
    beat.events = Array.isArray(beat.events) ? beat.events : synthesizeEvents({
      movement: beat.movement || {}, camera: beat.camera || {}, dialogue: beat.dialogue || '', rawDirection: beat.rawDirection || beat.description || '',
    });
    beat.relations = Array.isArray(beat.relations) ? normalizeBeatRelations(beat.relations, beat.events) : [];
  }
  graph.schemaVersion = SCHEMA_VERSION;
  graph.updatedAt = now();
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
  if (graph && graph.schemaVersion === 1) {
    graph = migrateV1(graph);
    writeGraph(graph);
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
  if (patch.constraints !== undefined) {
    if (!Array.isArray(patch.constraints)) throw new HttpError(400, 'constraints must be an array');
    graph.project.constraints = patch.constraints.slice(0, 128).map((x) => cleanText(x, 2000)).filter(Boolean);
  }
  if (patch.mediums !== undefined) {
    if (!Array.isArray(patch.mediums)) throw new HttpError(400, 'mediums must be an array');
    graph.project.mediums = patch.mediums.slice(0, 16).map((x) => cleanText(x, 128)).filter(Boolean);
  }
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
    const preferredId = ID_RE.test(rawLegacyId) ? rawLegacyId : `legacy_${safeLegacyPart(rawLegacyId)}`;
    const shotId = preferredId;
    const occupied = getShot(graph, shotId);
    if (occupied && (!occupied.source || occupied.source.legacyShotId !== rawLegacyId)) {
      throw new HttpError(409, `legacy shot bridge collision for "${rawLegacyId}"`);
    }
    shot = occupied || {
      id: shotId,
      sceneId,
      title: cleanText(title, 512) || rawLegacyId,
      description: cleanText(beat),
      purpose: '', startFrame: null, endFrame: null, cameraCues: { start: null, end: null }, camera: {}, dialogue: [],
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
    cameraCues: isObject(input.cameraCues)
      ? { start: input.cameraCues.start || null, end: input.cameraCues.end || null }
      : { start: null, end: null },
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


function normalizeBeatEvent(event, existing = []) {
  if (!isObject(event)) return null;
  const kind = EVENT_KINDS.includes(event.kind) ? event.kind : 'action';
  const id = event.id ? assertId(event.id, 'event id') : makeId('event', existing);
  const out = {
    id,
    kind,
    description: cleanText(event.description || event.action || event.dialogue || event.sound, 4000),
    actor: cleanText(event.actor, 512),
    bodyPart: cleanText(event.bodyPart, 512),
    target: cleanText(event.target, 1000),
    path: cleanText(event.path, 2000),
    quality: cleanText(event.quality, 2000),
    emotion: cleanText(event.emotion, 2000),
    timing: cleanText(event.timing, 2000),
    dialogue: cleanText(event.dialogue, 4000),
    sound: cleanText(event.sound, 2000),
    camera: isObject(event.camera) ? event.camera : {},
    contact: isObject(event.contact) ? {
      initiatorActor: cleanText(event.contact.initiatorActor, 512),
      initiatorBodyPart: cleanText(event.contact.initiatorBodyPart, 512),
      receiverActor: cleanText(event.contact.receiverActor, 512),
      receiverBodyPart: cleanText(event.contact.receiverBodyPart, 512),
      target: cleanText(event.contact.target, 1000),
      quality: cleanText(event.contact.quality, 2000),
    } : null,
    status: normalizeStatus(event.status),
    source: isObject(event.source) ? event.source : { kind: 'partner_interpretation' },
  };
  return out;
}

function eventSignature(event) {
  return [event.kind, event.description, event.actor, event.bodyPart, event.target, event.path,
    event.dialogue, event.sound, event.contact && JSON.stringify(event.contact)].join('|').toLowerCase();
}

function normalizeBeatEvents(events, existing = []) {
  if (!Array.isArray(events)) return [];
  if (events.length > 128) throw new HttpError(413, 'beat has too many events');
  const out = [];
  const used = new Set(existing.map((e) => e && e.id).filter(Boolean));
  const signatures = new Set(existing.map((e) => e && eventSignature(e)).filter(Boolean));
  for (const raw of events) {
    const event = normalizeBeatEvent(raw, [...existing, ...out]);
    if (!event) continue;
    if (used.has(event.id)) throw new HttpError(409, `duplicate event id "${event.id}"`);
    const sig = eventSignature(event);
    if (signatures.has(sig)) continue;
    used.add(event.id); signatures.add(sig); out.push(event);
  }
  return out;
}

function normalizeBeatRelations(relations, events) {
  if (!Array.isArray(relations)) return [];
  if (relations.length > 256) throw new HttpError(413, 'beat has too many event relations');
  const ids = new Set((events || []).map((e) => e.id));
  const seen = new Set();
  const out = [];
  for (const raw of relations) {
    if (!isObject(raw)) continue;
    const type = RELATION_KINDS.includes(raw.type) ? raw.type : null;
    const from = cleanText(raw.from, 128); const to = cleanText(raw.to, 128);
    if (!type || !ids.has(from) || !ids.has(to) || from === to) continue;
    const sig = `${type}|${from}|${to}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({
      type, from, to,
      description: cleanText(raw.description, 2000),
      source: isObject(raw.source) ? raw.source : { kind: 'partner_interpretation' },
    });
  }
  return out;
}

function synthesizeEvents({ movement = {}, camera = {}, dialogue = '', rawDirection = '' } = {}) {
  const events = [];
  if (isObject(movement) && Object.keys(movement).some((k) => cleanText(movement[k]))) {
    events.push(normalizeBeatEvent({
      id: 'movement', kind: /face|eyes|mouth|tongue|expression|gaze|breath/i.test(JSON.stringify(movement)) ? 'performance' : 'action',
      description: cleanText(movement.action || rawDirection, 4000), actor: movement.actor,
      bodyPart: movement.bodyPart, target: movement.target, path: movement.path,
      quality: movement.quality, emotion: movement.emotion, timing: movement.timing,
      sound: movement.sound,
    }, events));
  }
  if (isObject(camera) && Object.keys(camera).length) {
    events.push(normalizeBeatEvent({
      id: 'camera', kind: 'camera', description: cleanText(camera.description || camera.path || rawDirection, 4000),
      timing: camera.timing, quality: camera.quality, target: camera.target, camera,
    }, events));
  }
  if (cleanText(dialogue)) {
    events.push(normalizeBeatEvent({ id: 'dialogue', kind: 'dialogue', description: cleanText(dialogue, 4000), dialogue }, events));
  }
  return events.filter(Boolean);
}

function normalizeFrameAnchor(anchor) {
  if (!isObject(anchor)) return null;
  const out = {
    kind: cleanText(anchor.kind, 64) || 'direction_anchor',
    description: cleanText(anchor.description, 2000),
    framing: cleanText(anchor.framing, 1000),
    sourceAnnotationId: cleanText(anchor.sourceAnnotationId, 128) || null,
    referenceId: cleanText(anchor.referenceId, 256) || null,
    imageUrl: cleanText(anchor.imageUrl, 2000) || null,
  };
  if (isObject(anchor.point)) {
    const x = Number(anchor.point.x); const y = Number(anchor.point.y);
    if (Number.isFinite(x) && Number.isFinite(y)) out.point = { x, y };
  }
  if (isObject(anchor.geometry)) out.geometry = anchor.geometry;
  return out;
}

/**
 * Set one shot endpoint without forcing the artist to fill a shot form.
 * `start` and `end` can initially be path endpoints and later be upgraded to
 * actual sketch/image references without changing the shot contract.
 */
function setShotAnchor(shotId, slot, anchor) {
  // Backwards-compatible API name: a drawn path endpoint is a camera cue,
  // not an actual start/end frame reference.
  assertId(shotId, 'shotId');
  if (!['start', 'end'].includes(slot)) throw new HttpError(400, 'slot must be start or end');
  const graph = readGraph();
  const shot = getShot(graph, shotId);
  if (!shot) throw new HttpError(404, `unknown shot "${shotId}"`);
  shot.cameraCues = isObject(shot.cameraCues) ? shot.cameraCues : { start: null, end: null };
  shot.cameraCues[slot] = anchor == null ? null : normalizeFrameAnchor(anchor);
  shot.updatedAt = now();
  writeGraph(graph);
  return shot.cameraCues[slot];
}

/**
 * Attach an explicit visual start/landing frame reference. Unlike a camera
 * cue, this must point to an actual sketch/image/reference object.
 */
function setShotFrameRef(shotId, slot, frameRef) {
  assertId(shotId, 'shotId');
  if (!['start', 'end'].includes(slot)) throw new HttpError(400, 'slot must be start or end');
  const graph = readGraph();
  const shot = getShot(graph, shotId);
  if (!shot) throw new HttpError(404, `unknown shot "${shotId}"`);
  if (frameRef != null && !isObject(frameRef)) throw new HttpError(400, 'frameRef must be an object or null');
  if (frameRef && !frameRef.referenceId && !frameRef.imageUrl) {
    throw new HttpError(400, 'frameRef needs referenceId or imageUrl');
  }
  const key = slot === 'start' ? 'startFrame' : 'endFrame';
  shot[key] = frameRef == null ? null : {
    kind: cleanText(frameRef.kind, 64) || 'visual_reference',
    description: cleanText(frameRef.description, 2000),
    framing: cleanText(frameRef.framing, 1000),
    referenceId: cleanText(frameRef.referenceId, 256) || null,
    imageUrl: cleanText(frameRef.imageUrl, 2000) || null,
  };
  shot.updatedAt = now();
  writeGraph(graph);
  return shot[key];
}


/** Human/tool-facing shot packet assembled from the graph, not a duplicate store. */
function shotSpec(shotId) {
  const graph = readGraph();
  assertId(shotId, 'shotId');
  const shot = getShot(graph, shotId);
  if (!shot) throw new HttpError(404, `unknown shot "${shotId}"`);
  return {
    schemaVersion: graph.schemaVersion,
    scene: getScene(graph, shot.sceneId),
    shot,
    beats: graph.beats.filter((b) => b.shotId === shotId).sort((a, b) => a.order - b.order),
    annotations: graph.annotations.filter((a) => a.scopeType === 'shot' && a.scopeId === shotId),
    intents: graph.intents.filter((i) => i.shotId === shotId).slice(-24),
    updatedAt: graph.updatedAt,
  };
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
    events: [],
    relations: [],
    camera: isObject(input.camera) ? input.camera : {},
    timing: isObject(input.timing) ? input.timing : {},
    dialogue: cleanText(input.dialogue),
    preserve: Array.isArray(input.preserve) ? input.preserve.map((x) => cleanText(x, 1000)).filter(Boolean) : [],
    status: normalizeStatus(input.status),
    source: isObject(input.source) ? input.source : { kind: 'user' },
    createdAt: now(),
    updatedAt: now(),
  };
  const explicitEvents = normalizeBeatEvents(input.events, []);
  beat.events = explicitEvents.length ? explicitEvents : synthesizeEvents({
    movement: beat.movement, camera: beat.camera, dialogue: beat.dialogue, rawDirection: beat.rawDirection,
  });
  beat.relations = normalizeBeatRelations(input.relations, beat.events);
  graph.beats.push(beat);
  writeGraph(graph);
  return beat;
}

function updateBeat(beatId, patch = {}) {
  assertId(beatId, 'beat id');
  const graph = readGraph();
  const beat = graph.beats.find((item) => item.id === beatId);
  if (!beat) throw new HttpError(404, `unknown beat "${beatId}"`);

  // Raw artist wording is authoritative and is only replaced when an explicit
  // rawDirection is supplied. Partner enrichment fills structure around it.
  if (patch.rawDirection !== undefined) beat.rawDirection = cleanText(patch.rawDirection);
  if (patch.description !== undefined) beat.description = cleanText(patch.description);
  if (patch.movement !== undefined) beat.movement = {
    ...(beat.movement || {}),
    ...normalizeMovement(patch.movement),
  };
  if (patch.camera !== undefined && isObject(patch.camera)) beat.camera = {
    ...(beat.camera || {}),
    ...patch.camera,
  };
  if (patch.events !== undefined) {
    const existingEvents = Array.isArray(beat.events) ? beat.events : [];
    const additions = normalizeBeatEvents(patch.events, existingEvents);
    beat.events = [...existingEvents, ...additions];
  }
  if (!Array.isArray(beat.events) || !beat.events.length) {
    beat.events = synthesizeEvents({ movement: beat.movement, camera: beat.camera, dialogue: beat.dialogue, rawDirection: beat.rawDirection });
  }
  if (patch.relations !== undefined) {
    const nextRelations = normalizeBeatRelations(patch.relations, beat.events);
    const current = Array.isArray(beat.relations) ? beat.relations : [];
    const seen = new Set(current.map((r) => `${r.type}|${r.from}|${r.to}`));
    beat.relations = [...current, ...nextRelations.filter((r) => !seen.has(`${r.type}|${r.from}|${r.to}`))];
  }
  if (!Array.isArray(beat.relations)) beat.relations = [];
  if (patch.timing !== undefined && isObject(patch.timing)) beat.timing = {
    ...(beat.timing || {}),
    ...patch.timing,
  };
  if (patch.dialogue !== undefined) beat.dialogue = cleanText(patch.dialogue);
  if (patch.preserve !== undefined && Array.isArray(patch.preserve)) {
    const next = patch.preserve.map((x) => cleanText(x, 1000)).filter(Boolean);
    beat.preserve = Array.from(new Set([...(beat.preserve || []), ...next]));
  }
  if (patch.status !== undefined) beat.status = normalizeStatus(patch.status, beat.status || 'provisional');
  if (isObject(patch.enrichment)) {
    beat.enrichments = Array.isArray(beat.enrichments) ? beat.enrichments : [];
    beat.enrichments.push({
      ...patch.enrichment,
      createdAt: now(),
    });
    beat.enrichments = beat.enrichments.slice(-24);
  }
  beat.updatedAt = now();
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
  STATUS, EVENT_KINDS, RELATION_KINDS, emptyGraph, migrateV1, isValidGraph, readGraph, writeGraph, setProject,
  createScene, createShot, createBeat, updateBeat, addAnnotation, recordIntent, summary,
  normalizeMovement, normalizeBeatEvent, normalizeBeatEvents, normalizeBeatRelations, synthesizeEvents,
  normalizeFrameAnchor, setShotAnchor, setShotFrameRef, shotSpec,
  ensureLegacyShot, safeLegacyPart,
};
