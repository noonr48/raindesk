'use strict';

/**
 * Raindesk Partner orchestration.
 *
 * Surface contract: one friendly creative partner.
 * Internal contract: every turn produces a structured, reversible envelope
 * that can later drive board actions and specialist tool workflows without
 * forcing the artist to think about the pipeline.
 */

const direction = require('./direction');
const router = require('./workflow-router');
const partnerTurns = require('./partner-turns');
const partnerActions = require('./partner-actions');

const BOARD_ACTIONS = new Set([
  'focus', 'open_panel', 'close_panel', 'move_panel', 'dock_panel',
  'pin_reference', 'create_variant', 'compare_takes', 'arrange', 'link',
  'create_scene', 'create_shot', 'create_beat', 'add_annotation',
]);
const MAX_CONTEXT_CHARS = 7000;
const MAX_NEXT_MOVES = 3;

function isObject(v) { return Boolean(v && typeof v === 'object' && !Array.isArray(v)); }
function text(v, max = 4000) {
  const s = v == null ? '' : String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

function parseJsonObject(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const tries = [s];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) tries.push(fence[1].trim());
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a !== -1 && b > a) tries.push(s.slice(a, b + 1));
  for (const candidate of tries) {
    try {
      const value = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch (_e) { /* try next extraction */ }
  }
  return null;
}

function normalizeNextMoves(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_NEXT_MOVES).map((item) => {
    if (typeof item === 'string') return { label: text(item, 160), prompt: text(item, 1000), kind: 'continue' };
    if (!isObject(item)) return null;
    const label = text(item.label || item.title || item.prompt, 160);
    if (!label) return null;
    return {
      label,
      prompt: text(item.prompt || item.message || label, 1200),
      kind: text(item.kind || 'continue', 64),
    };
  }).filter(Boolean);
}

function actionDisposition(partnerMode, type) {
  if (partnerMode === 'watch') return 'advisory';
  if (partnerMode === 'suggest') return 'proposal';
  // Act mode still keeps destructive/creative content changes reviewable.
  // UI-only organisation may eventually auto-execute; content creation remains a take.
  return ['focus', 'open_panel', 'close_panel', 'move_panel', 'dock_panel', 'arrange'].includes(type)
    ? 'auto' : 'proposal';
}

function normalizeBoardActions(value, partnerMode) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).map((item) => {
    if (!isObject(item) || !BOARD_ACTIONS.has(item.type)) return null;
    const out = { type: item.type, disposition: actionDisposition(partnerMode, item.type) };
    for (const key of ['targetId', 'scopeId', 'scopeType', 'label', 'position', 'panel', 'recipeId']) {
      if (item[key] !== undefined) out[key] = item[key];
    }
    if (isObject(item.payload)) out.payload = item.payload;
    return out;
  }).filter(Boolean);
}

function looksStuck(message, explicitMode, summary) {
  if (explicitMode === 'kickstart') return true;
  const msg = String(message || '').toLowerCase();
  if (!msg.trim() && summary.counts.scenes === 0) return true;
  return /\b(stuck|freeze|frozen|blank|don't know|dont know|not sure|where do i start|where to start|help me start|give me ideas|no idea|mental block|can't think|cant think)\b/i.test(msg);
}

function kickstartSeed(summary) {
  if (summary.counts.scenes === 0) {
    return {
      message: "We don't need to solve the whole project. Give me one scene or moment you can see at all — even badly — and I'll lay out a loose starting board around it.",
      nextMoves: [
        { label: 'Lay out 3 rough starting shots', prompt: 'Take the clearest scene idea we have and lay out 3 rough starting shots.', kind: 'rough_options' },
        { label: 'Pull in characters + references', prompt: 'Set up a loose board with the relevant characters and references first.', kind: 'setup' },
        { label: 'Start from one key moment', prompt: 'Help me pick one key emotional or action moment and start there.', kind: 'key_moment' },
      ],
    };
  }
  if (summary.activeScene && !summary.activeShot) {
    return {
      message: "Let's only find the first useful image in this scene. We can keep it disposable and make a few directions before committing to anything.",
      nextMoves: [
        { label: 'Try 3 opening compositions', prompt: 'Give me 3 rough opening composition directions for this scene.', kind: 'rough_options' },
        { label: 'Find the key action beat', prompt: 'Find the key action or emotional beat in this scene and start the board there.', kind: 'key_moment' },
        { label: 'Ask me one easy question', prompt: 'Ask me one small visual question that will get this scene moving.', kind: 'question' },
      ],
    };
  }
  if (summary.activeShot && summary.activeBeats.length === 0) {
    return {
      message: "We already have the shot. Let's solve only the next couple of seconds: where it starts, one thing that changes, and where it lands.",
      nextMoves: [
        { label: 'Block start → action → landing', prompt: 'Help me block a start frame, one core action, and a landing frame for this shot.', kind: 'beat_block' },
        { label: 'Explore the camera move', prompt: 'Give me 2-3 simple camera movement ideas for this shot.', kind: 'camera' },
        { label: 'Focus on the acting first', prompt: 'Ignore polish and help me find the performance beat first.', kind: 'performance' },
      ],
    };
  }
  return {
    message: "Pick the piece you feel anything about — good or bad. We can push that one, compare a second take, and let the next decision come from your reaction.",
    nextMoves: [
      { label: 'Push the current take', prompt: 'Push the current take in the direction already implied by my notes.', kind: 'refine' },
      { label: 'Make a contrasting take', prompt: 'Make one clearly contrasting take so I can react to the difference.', kind: 'variant' },
      { label: 'Find the weakest beat', prompt: 'Point out the weakest or least clear beat and give me a small next move.', kind: 'review' },
    ],
  };
}

function compactContext(summary, extra) {
  const pickScene = (scene) => scene ? {
    id: scene.id, title: text(scene.title, 400), description: text(scene.description, 1200),
    purpose: text(scene.purpose, 800), mood: text(scene.mood, 500),
    participants: Array.isArray(scene.participants) ? scene.participants.slice(0, 12) : [],
    status: scene.status,
  } : null;
  const pickShot = (shot) => shot ? {
    id: shot.id, sceneId: shot.sceneId, title: text(shot.title, 400),
    description: text(shot.description, 1200), purpose: text(shot.purpose, 800),
    startFrame: shot.startFrame || null, endFrame: shot.endFrame || null,
    cameraCues: shot.cameraCues || { start: null, end: null },
    camera: shot.camera || {}, preserve: Array.isArray(shot.preserve) ? shot.preserve.slice(0, 12) : [],
    change: Array.isArray(shot.change) ? shot.change.slice(0, 12) : [],
    status: shot.status,
  } : null;
  const context = {
    direction: {
      project: summary.project ? {
        title: text(summary.project.title, 400),
        creativeState: summary.project.creativeState,
        partnerMode: summary.project.partnerMode,
        activeSceneId: summary.project.activeSceneId,
        activeShotId: summary.project.activeShotId,
      } : null,
      counts: summary.counts,
      activeScene: pickScene(summary.activeScene),
      activeShot: pickShot(summary.activeShot),
      activeBeats: Array.isArray(summary.activeBeats) ? summary.activeBeats.slice(-10).map((beat) => ({
        id: beat.id, order: beat.order, rawDirection: text(beat.rawDirection, 800),
        description: text(beat.description, 800), movement: beat.movement || {},
        events: Array.isArray(beat.events) ? beat.events.slice(-12) : [],
        relations: Array.isArray(beat.relations) ? beat.relations.slice(-16) : [],
        camera: beat.camera || {}, dialogue: text(beat.dialogue, 500), status: beat.status,
      })) : [],
      activeAnnotations: Array.isArray(summary.activeAnnotations) ? summary.activeAnnotations.slice(-8).map((ann) => ({
        id: ann.id, kind: ann.kind, rawText: text(ann.rawText, 700),
        interpretation: ann.interpretation || {}, status: ann.status,
      })) : [],
      openQuestions: Array.isArray(summary.openQuestions) ? summary.openQuestions.slice(-6) : [],
    },
    activeSelection: isObject(extra && extra.selection) ? extra.selection : null,
    activeBeatId: text(extra && extra.activeBeatId, 128) || null,
    activeBeat: isObject(extra && extra.activeBeat) ? {
      id: text(extra.activeBeat.id, 128), order: Number(extra.activeBeat.order) || 0,
      rawDirection: text(extra.activeBeat.rawDirection, 1200),
      events: Array.isArray(extra.activeBeat.events) ? extra.activeBeat.events.slice(-12) : [],
      relations: Array.isArray(extra.activeBeat.relations) ? extra.activeBeat.relations.slice(-16) : [],
      startFrame: extra.activeBeat.startFrame || null, endFrame: extra.activeBeat.endFrame || null,
    } : null,
    directingConstraints: isObject(extra && extra.directingConstraints) ? {
      preserve: Array.isArray(extra.directingConstraints.preserve) ? extra.directingConstraints.preserve.slice(0, 24) : [],
      change: Array.isArray(extra.directingConstraints.change) ? extra.directingConstraints.change.slice(0, 24) : [],
      startFrame: extra.directingConstraints.startFrame || null,
      endFrame: extra.directingConstraints.endFrame || null,
    } : null,
    activeCanvas: isObject(extra && extra.canvas) ? extra.canvas : null,
    artRevisionId: text(extra && extra.artRevisionId, 128) || null,
    visibleLayers: Array.isArray(extra && extra.visibleLayers) ? extra.visibleLayers.slice(0, 48) : [],
    recentConversation: Array.isArray(extra && extra.recentConversation)
      ? extra.recentConversation.slice(-8).map((turn) => ({
        user: text(turn && (turn.user || turn.userMessage), 1000),
        partner: text(turn && (turn.partner || turn.partnerMessage), 1000),
      })) : [],
    nearbyNotes: Array.isArray(extra && extra.nearbyNotes)
      ? extra.nearbyNotes.slice(-12).map((n) => text(n, 700)).filter(Boolean)
      : [],
    workspace: isObject(extra && extra.workspace) ? {
      viewport: isObject(extra.workspace.viewport) ? extra.workspace.viewport : null,
      objects: Array.isArray(extra.workspace.objects) ? extra.workspace.objects.slice(0, 32).map((obj) => ({
        id: text(obj && obj.id, 128), type: text(obj && obj.type, 128),
        entityRef: obj && obj.entityRef || null, x: Number(obj && obj.x) || 0, y: Number(obj && obj.y) || 0,
        width: Number(obj && obj.width) || 0, height: Number(obj && obj.height) || 0,
        dock: text(obj && obj.dock, 32) || null, visible: obj ? obj.visible !== false : false,
        collapsed: Boolean(obj && obj.collapsed),
      })).filter((obj) => obj.id) : [],
    } : null,
  };

  // Always emit valid JSON. When context is too large, remove complete
  // low-priority items rather than cutting serialized JSON mid-token.
  const encode = () => JSON.stringify(context);
  let raw = encode();
  const buckets = [
    context.nearbyNotes,
    context.recentConversation,
    context.direction.activeAnnotations,
    context.direction.activeBeats,
    context.direction.openQuestions,
    context.workspace && context.workspace.objects,
  ].filter(Boolean);
  let guard = 0;
  while (raw.length > MAX_CONTEXT_CHARS && guard++ < 128) {
    const bucket = buckets.find((arr) => Array.isArray(arr) && arr.length > 1);
    if (!bucket) break;
    bucket.shift();
    raw = encode();
  }
  if (raw.length > MAX_CONTEXT_CHARS && context.direction.activeShot) {
    context.direction.activeShot.description = text(context.direction.activeShot.description, 400);
    context.direction.activeShot.purpose = text(context.direction.activeShot.purpose, 300);
    raw = encode();
  }
  if (raw.length > MAX_CONTEXT_CHARS && context.direction.activeScene) {
    context.direction.activeScene.description = text(context.direction.activeScene.description, 300);
    context.direction.activeScene.purpose = text(context.direction.activeScene.purpose, 250);
    raw = encode();
  }
  return raw;
}

function buildPrompt({ message, summary, extraContext, kickstart }) {
  const seed = kickstart ? kickstartSeed(summary) : null;
  return `RAINDESK PARTNER TURN\n\nYou are the single creative partner visible to the artist. The artist stays in the art space: sketches, arrows, captions, movement descriptions, camera ideas and casual conversation. You quietly translate that into scene -> shot -> beat intent and production workflows. Never make them choose technical tools or pipeline nodes.\n\nImportant behaviour:\n- Talk like a concise creative partner, not a production dashboard.\n- When the artist is stuck, reduce scope and offer 2-3 low-commitment ways to start. Do not ask them to define the whole project.\n- Preserve the artist's raw wording. Interpret movement in terms of actor, preparation, action, body part, target/contact, path, quality, timing, emotion, follow-through and camera relationship when useful.\n- When one sentence contains multiple meaningful actions, performance moments, dialogue, camera moves, sounds or contacts, split them into lightweight events and express only useful timing relationships such as before/after/during/overlaps/follows. Do not over-segment simple direction.\n- Interpret camera notes in terms of start framing, path, target, landing framing and timing when useful.\n- Prefer reversible takes and preserve boundaries over destructive regeneration.\n- Treat keep/preserve constraints in context as hard creative boundaries unless the artist explicitly changes them. Treat change constraints as the intended edit scope. Never silently broaden the change beyond those boundaries.\n- If a direction mark is attached to an active beat, interpret it as detail for that beat rather than inventing a duplicate beat.\n- Ask at most ONE clarifying question, only when ambiguity materially changes the creative meaning.\n- Board actions are suggestions unless permission mode allows harmless organisation.\n\nCurrent context (may be partial):\n${compactContext(summary, extraContext)}\n\n${seed ? `If useful, use this anti-freeze seed rather than making the user invent structure:\n${JSON.stringify(seed)}\n\n` : ''}Artist message:\n${text(message, 6000) || '(no message; they asked for a starting nudge)'}\n\nReturn JSON ONLY with this shape:\n{\n  "message": "1-4 short conversational sentences",\n  "interpretation": {\n    "kind": "creative_direction|movement|camera|performance|edit|setup|review",\n    "scene": "optional",\n    "shot": "optional",\n    "movement": {"actor":"","preparation":"","action":"","bodyPart":"","target":"","path":"","quality":"","timing":"","emotion":"","followThrough":"","cameraRelation":""},\n    "camera": {"start":"","framingStart":"","path":"","target":"","end":"","framingEnd":"","timing":"","quality":""},\n    "events": [{"id":"e1","kind":"action|performance|dialogue|camera|contact|sound","description":"","actor":"","bodyPart":"","target":"","path":"","quality":"","emotion":"","timing":"","dialogue":"","sound":"","contact":{"initiatorActor":"","initiatorBodyPart":"","receiverActor":"","receiverBodyPart":"","target":"","quality":""}}],\n    "relations": [{"type":"before|after|during|overlaps|follows|causes|simultaneous","from":"e1","to":"e2","description":"optional"}],\n    "editScope": "optional",\n    "preserve": ["optional constraints"],\n    "confidence": 0.0\n  },\n  "nextMoves": [{"label":"short button label","prompt":"what selecting it tells you","kind":"continue"}],\n  "workflowHints": ["optional stable recipe ids such as camera_reveal or contact_action"],\n  "boardActions": [{"type":"focus|open_panel|move_panel|dock_panel|pin_reference|create_variant|compare_takes|arrange|link|create_scene|create_shot|create_beat|add_annotation", "targetId":"optional", "payload":{}}],\n  "question": "optional single clarifying question"\n}`;
}

function mergeWorkflows(parsed, message, kickstart) {
  const deterministic = router.rankRecipes({ raw: message, interpretation: parsed && parsed.interpretation }, { kickstart });
  const ids = new Set();
  const out = [];
  const hinted = Array.isArray(parsed && parsed.workflowHints) ? parsed.workflowHints : [];
  for (const id of hinted) {
    const recipe = router.getRecipe(id);
    if (recipe && !ids.has(id)) { ids.add(id); out.push({ ...recipe, reason: 'partner interpretation' }); }
  }
  for (const recipe of deterministic) {
    if (!ids.has(recipe.id)) { ids.add(recipe.id); out.push(recipe); }
  }
  return out.slice(0, 3);
}

function fallbackInterpretation(message, context = {}, kickstart = false) {
  const selection = isObject(context.selection) ? context.selection : {};
  const raw = text(selection.rawText || message, 6000);
  if (kickstart) return { kind: 'setup', confidence: 0.4 };
  if (!raw) return { kind: 'creative_direction', confidence: 0.15 };

  const cameraRe = /\b(camera|cam|orbit|spiral|push in|push-in|pull back|dolly|pan|tilt|crane|zoom|framing|frame|shot moves|lens)\b/i;
  const movementRe = /\b(move|moves|step|turn|raise|lower|shake|fist|stand|sit|lean|reach|walk|run|recoil|crouch|jump|gesture|point|swing|twist|shift|lunge|punch|kick|grab|catch|wrist|hand|arm|leg|body)\b/i;
  const performanceRe = /\b(expression|face|eyes|gaze|mouth|tongue|breath|speaks|says|dialogue|smile|frown|anger|hesitat|reaction|whisper|shout)\b/i;
  const timingMatch = raw.match(/\b(while|before|after|during|then|as soon as|at the same time|hold|delay|pause)[^,.!?;]*/i);
  const timing = timingMatch ? text(timingMatch[0], 1000) : '';

  if (cameraRe.test(raw)) {
    return {
      kind: 'camera',
      camera: { path: raw, timing },
      preserve: [],
      confidence: 0.35,
      provisionalReason: 'language fallback; preserve the artist wording until Partner interpretation is available',
    };
  }
  if (movementRe.test(raw)) {
    return {
      kind: 'movement',
      movement: { action: raw, timing },
      preserve: [],
      confidence: performanceRe.test(raw) ? 0.38 : 0.32,
      provisionalReason: 'movement fallback; raw wording remains authoritative',
    };
  }
  if (performanceRe.test(raw)) {
    return {
      kind: 'performance',
      movement: { action: raw, timing },
      preserve: [],
      confidence: 0.32,
      provisionalReason: 'performance fallback; raw wording remains authoritative',
    };
  }
  return { kind: 'creative_direction', description: raw, confidence: 0.2 };
}

function normalizeEnvelope(parsed, rawReply, { message, summary, kickstart, partnerMode, context = {} }) {
  const seed = kickstart ? kickstartSeed(summary) : null;
  const p = isObject(parsed) ? parsed : {};
  const partnerMessage = text(p.message, 5000) || (seed && seed.message) || text(rawReply, 5000) ||
    "I'm with you. Pick one thing you want to feel different and we'll work from there.";
  const nextMoves = normalizeNextMoves(p.nextMoves);
  const resolvedMoves = nextMoves.length ? nextMoves : (seed ? seed.nextMoves : []);
  const interpretation = isObject(p.interpretation)
    ? p.interpretation
    : fallbackInterpretation(message, context, kickstart);
  return {
    message: partnerMessage,
    interpretation,
    nextMoves: resolvedMoves.slice(0, MAX_NEXT_MOVES),
    workflow: mergeWorkflows(p, message, kickstart),
    boardActions: normalizeBoardActions(p.boardActions, partnerMode),
    question: text(p.question, 800) || null,
    kickstart,
    partnerMode,
  };
}


function captureInterpretedBeat(directionImpl, envelope, message, context, intent) {
  if (!intent || !context || !context.shotId) return null;
  const interpretation = isObject(envelope.interpretation) ? envelope.interpretation : {};
  const kind = text(interpretation.kind, 64);
  if (!['movement', 'performance', 'camera'].includes(kind)) return null;

  const graph = directionImpl.readGraph();
  const existing = (graph.beats || []).find((beat) => beat && beat.source && beat.source.intentId === intent.id);
  if (existing) return { beatId: existing.id, shotId: existing.shotId, existing: true };

  const selection = isObject(context.selection) ? context.selection : {};
  const rawDirection = text(selection.rawText || message, 12000);
  if (!rawDirection) return null;

  // Duplicate-turn dedupe (handover §9D adjacent): an identical resent message
  // mints a fresh intent (new intentId), so the intentId check above misses it.
  // Reuse a prior partner-captured beat in this shot with identical raw wording
  // instead of stacking a duplicate provisional beat.
  const prior = (graph.beats || []).find((beat) => beat && beat.shotId === context.shotId &&
    beat.rawDirection === rawDirection && beat.source && beat.source.kind === 'partner_capture');
  if (prior) return { beatId: prior.id, shotId: prior.shotId, existing: true, deduped: true };
  const movement = isObject(interpretation.movement) ? interpretation.movement : {};
  const camera = isObject(interpretation.camera) ? interpretation.camera : {};
  const preserve = Array.isArray(interpretation.preserve) ? interpretation.preserve : [];
  const events = Array.isArray(interpretation.events) ? interpretation.events : [];
  const relations = Array.isArray(interpretation.relations) ? interpretation.relations : [];
  const timing = isObject(interpretation.timing) ? interpretation.timing :
    (movement.timing ? { relationship: text(movement.timing, 2000) } : {});

  if (context.precreatedBeatId && typeof directionImpl.updateBeat === 'function') {
    const precreated = (graph.beats || []).find((beat) => beat.id === context.precreatedBeatId);
    if (precreated && precreated.shotId === context.shotId) {
      const beat = directionImpl.updateBeat(precreated.id, {
        description: text(interpretation.description || interpretation.action || rawDirection, 4000),
        movement,
        events,
        relations,
        camera,
        timing,
        dialogue: text(interpretation.dialogue, 4000),
        preserve,
        status: 'provisional',
        enrichment: { kind: 'partner_capture', intentId: intent.id, interpretationKind: kind },
      });
      return { beatId: beat.id, shotId: beat.shotId, existing: true, enriched: true };
    }
  }


  if (context.surface === 'direction_annotation' && context.activeBeatId && typeof directionImpl.updateBeat === 'function') {
    const active = (graph.beats || []).find((beat) => beat && beat.id === context.activeBeatId && beat.shotId === context.shotId);
    if (active) {
      const beat = directionImpl.updateBeat(active.id, {
        description: text(active.description || interpretation.description || interpretation.action || rawDirection, 4000),
        movement: Object.keys(movement).length ? movement : active.movement,
        events: events.length ? events : active.events,
        relations: relations.length ? relations : active.relations,
        camera: Object.keys(camera).length ? camera : active.camera,
        timing: Object.keys(timing).length ? timing : active.timing,
        dialogue: text(interpretation.dialogue, 4000) || active.dialogue,
        preserve: preserve.length ? preserve : active.preserve,
        status: active.status || 'provisional',
        enrichment: { kind: 'partner_direction_annotation', intentId: intent.id, interpretationKind: kind },
      });
      return { beatId: beat.id, shotId: beat.shotId, existing: true, enriched: true, fromDirectionAnnotation: true };
    }
  }

  const beat = directionImpl.createBeat({
    shotId: context.shotId,
    description: text(interpretation.description || interpretation.action || rawDirection, 4000),
    rawDirection,
    movement,
    events,
    relations,
    camera,
    timing,
    dialogue: text(interpretation.dialogue, 4000),
    preserve,
    status: 'provisional',
    source: { kind: 'partner_capture', intentId: intent.id, interpretationKind: kind },
  });
  return { beatId: beat.id, shotId: beat.shotId, existing: false };
}

function createPartner({ agentImpl, directionImpl = direction, turnStore = partnerTurns, actionStore = partnerActions } = {}) {
  if (!agentImpl || typeof agentImpl.chat !== 'function') throw new Error('agentImpl.chat is required');

  async function turn({ message = '', mode = null, context = {} } = {}) {
    const resolvedContext = isObject(context) ? { ...context } : {};
    // Permission mode is read before any legacy bridging because Watch must be
    // genuinely read-only, including semantic project state.
    let graph = directionImpl.readGraph();
    const partnerMode = graph.project && graph.project.partnerMode || 'suggest';

    if (turnStore && typeof turnStore.recent === 'function') {
      try {
        resolvedContext.recentConversation = turnStore.recent({
          projectId: graph.project && graph.project.id || 'project',
          sceneId: resolvedContext.sceneId || graph.project.activeSceneId || null,
          shotId: resolvedContext.shotId || graph.project.activeShotId || null,
          limit: 6,
        }).map((turn) => ({ userMessage: turn.userMessage, partnerMessage: turn.partnerMessage }));
      } catch (_e) { /* conversational memory must never block the live turn */ }
    }

    if (partnerMode !== 'watch' && !resolvedContext.shotId &&
      resolvedContext.legacyShotId && typeof directionImpl.ensureLegacyShot === 'function') {
      try {
        const bridge = directionImpl.ensureLegacyShot(resolvedContext.legacyShotId, {
          beat: resolvedContext.legacyBeat || '',
          title: resolvedContext.legacyShotId,
        });
        resolvedContext.sceneId = bridge.sceneId;
        resolvedContext.shotId = bridge.shotId;
        graph = directionImpl.readGraph();
      } catch (_e) { /* context bridging must never block conversation */ }
    }

    const summary = directionImpl.summary(graph);
    const kickstart = looksStuck(message, mode, summary);
    const prompt = buildPrompt({ message, summary, extraContext: resolvedContext, kickstart });
    let rawReply = '';
    try { rawReply = await agentImpl.chat(prompt); } catch (_e) { rawReply = ''; }
    const parsed = parseJsonObject(rawReply);
    const envelope = normalizeEnvelope(parsed, rawReply, {
      message, summary, kickstart, partnerMode, context: resolvedContext,
    });

    let intent = null;
    let captured = null;
    if (partnerMode !== 'watch') {
      try {
        intent = directionImpl.recordIntent({
          raw: message || (kickstart ? '[kickstart]' : ''),
          kind: text(envelope.interpretation.kind, 128) || 'creative_direction',
          sceneId: resolvedContext.sceneId || undefined,
          shotId: resolvedContext.shotId || undefined,
          interpretation: envelope.interpretation,
          workflowHints: envelope.workflow.map((w) => w.id),
          status: 'provisional',
          source: { kind: 'partner_turn', kickstart },
        });
      } catch (_e) { /* conversation stays live even if semantic logging fails */ }

      try {
        captured = captureInterpretedBeat(directionImpl, envelope, message, resolvedContext, intent);
      } catch (_e) { /* raw conversation survives independently of enrichment */ }
    }

    let persistedTurn = null;
    if (turnStore && typeof turnStore.record === 'function') {
      try {
        persistedTurn = turnStore.record({
          projectId: graph.project && graph.project.id || 'project',
          sceneId: resolvedContext.sceneId || graph.project.activeSceneId || null,
          shotId: resolvedContext.shotId || graph.project.activeShotId || null,
          userMessage: message,
          partnerMessage: envelope.message,
          permissionMode: partnerMode,
          interpretation: envelope.interpretation,
          nextMoves: envelope.nextMoves,
          workflow: envelope.workflow,
          boardActions: envelope.boardActions,
          intentId: intent ? intent.id : null,
          captured,
        });
      } catch (_e) { /* memory failure does not strand the artist */ }
    }

    const actionRecords = [];
    if (actionStore && typeof actionStore.recordProposal === 'function') {
      for (const action of envelope.boardActions) {
        try {
          actionRecords.push(actionStore.recordProposal(action, {
            permissionMode: partnerMode,
            turnId: persistedTurn ? persistedTurn.id : null,
          }));
        } catch (_e) { /* malformed proposals remain harmless model output */ }
      }
    }

    return {
      ...envelope,
      permissionMode: partnerMode,
      intentId: intent ? intent.id : null,
      captured,
      turnId: persistedTurn ? persistedTurn.id : null,
      actions: actionRecords,
    };
  }

  return { turn };
}

module.exports = {
  BOARD_ACTIONS, parseJsonObject, normalizeNextMoves, normalizeBoardActions,
  looksStuck, kickstartSeed, buildPrompt, fallbackInterpretation,
  captureInterpretedBeat, createPartner,
};
