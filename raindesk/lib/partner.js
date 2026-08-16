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
  const context = {
    direction: summary,
    activeSelection: isObject(extra && extra.selection) ? extra.selection : null,
    activeCanvas: isObject(extra && extra.canvas) ? extra.canvas : null,
    nearbyNotes: Array.isArray(extra && extra.nearbyNotes) ? extra.nearbyNotes.slice(0, 12) : [],
  };
  const raw = JSON.stringify(context);
  return raw.length > MAX_CONTEXT_CHARS ? raw.slice(0, MAX_CONTEXT_CHARS) + '…' : raw;
}

function buildPrompt({ message, summary, extraContext, kickstart }) {
  const seed = kickstart ? kickstartSeed(summary) : null;
  return `RAINDESK PARTNER TURN\n\nYou are the single creative partner visible to the artist. The artist stays in the art space: sketches, arrows, captions, movement descriptions, camera ideas and casual conversation. You quietly translate that into scene -> shot -> beat intent and production workflows. Never make them choose technical tools or pipeline nodes.\n\nImportant behaviour:\n- Talk like a concise creative partner, not a production dashboard.\n- When the artist is stuck, reduce scope and offer 2-3 low-commitment ways to start. Do not ask them to define the whole project.\n- Preserve the artist's raw wording. Interpret movement in terms of actor, preparation, action, body part, target/contact, path, quality, timing, emotion, follow-through and camera relationship when useful.\n- Interpret camera notes in terms of start framing, path, target, landing framing and timing when useful.\n- Prefer reversible takes and preserve boundaries over destructive regeneration.\n- Ask at most ONE clarifying question, only when ambiguity materially changes the creative meaning.\n- Board actions are suggestions unless permission mode allows harmless organisation.\n\nCurrent context (may be partial):\n${compactContext(summary, extraContext)}\n\n${seed ? `If useful, use this anti-freeze seed rather than making the user invent structure:\n${JSON.stringify(seed)}\n\n` : ''}Artist message:\n${text(message, 6000) || '(no message; they asked for a starting nudge)'}\n\nReturn JSON ONLY with this shape:\n{\n  "message": "1-4 short conversational sentences",\n  "interpretation": {\n    "kind": "creative_direction|movement|camera|performance|edit|setup|review",\n    "scene": "optional",\n    "shot": "optional",\n    "movement": {"actor":"","preparation":"","action":"","bodyPart":"","target":"","path":"","quality":"","timing":"","emotion":"","followThrough":"","cameraRelation":""},\n    "camera": {"start":"","framingStart":"","path":"","target":"","end":"","framingEnd":"","timing":"","quality":""},\n    "editScope": "optional",\n    "preserve": ["optional constraints"],\n    "confidence": 0.0\n  },\n  "nextMoves": [{"label":"short button label","prompt":"what selecting it tells you","kind":"continue"}],\n  "workflowHints": ["optional stable recipe ids such as camera_reveal or contact_action"],\n  "boardActions": [{"type":"focus|open_panel|move_panel|dock_panel|pin_reference|create_variant|compare_takes|arrange|link|create_scene|create_shot|create_beat|add_annotation", "targetId":"optional", "payload":{}}],\n  "question": "optional single clarifying question"\n}`;
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

function normalizeEnvelope(parsed, rawReply, { message, summary, kickstart, partnerMode }) {
  const seed = kickstart ? kickstartSeed(summary) : null;
  const p = isObject(parsed) ? parsed : {};
  const partnerMessage = text(p.message, 5000) || (seed && seed.message) || text(rawReply, 5000) ||
    "I'm with you. Pick one thing you want to feel different and we'll work from there.";
  const nextMoves = normalizeNextMoves(p.nextMoves);
  const resolvedMoves = nextMoves.length ? nextMoves : (seed ? seed.nextMoves : []);
  const interpretation = isObject(p.interpretation) ? p.interpretation : { kind: kickstart ? 'setup' : 'creative_direction' };
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
  const movement = isObject(interpretation.movement) ? interpretation.movement : {};
  const camera = isObject(interpretation.camera) ? interpretation.camera : {};
  const preserve = Array.isArray(interpretation.preserve) ? interpretation.preserve : [];
  const timing = isObject(interpretation.timing) ? interpretation.timing :
    (movement.timing ? { relationship: text(movement.timing, 2000) } : {});

  const beat = directionImpl.createBeat({
    shotId: context.shotId,
    description: text(interpretation.description || interpretation.action || rawDirection, 4000),
    rawDirection,
    movement,
    camera,
    timing,
    dialogue: text(interpretation.dialogue, 4000),
    preserve,
    status: 'provisional',
    source: { kind: 'partner_capture', intentId: intent.id, interpretationKind: kind },
  });
  return { beatId: beat.id, shotId: beat.shotId, existing: false };
}

function createPartner({ agentImpl, directionImpl = direction } = {}) {
  if (!agentImpl || typeof agentImpl.chat !== 'function') throw new Error('agentImpl.chat is required');

  async function turn({ message = '', mode = null, context = {} } = {}) {
    const resolvedContext = isObject(context) ? { ...context } : {};
    if (!resolvedContext.shotId && resolvedContext.legacyShotId && typeof directionImpl.ensureLegacyShot === 'function') {
      try {
        const bridge = directionImpl.ensureLegacyShot(resolvedContext.legacyShotId, {
          beat: resolvedContext.legacyBeat || '',
          title: resolvedContext.legacyShotId,
        });
        resolvedContext.sceneId = bridge.sceneId;
        resolvedContext.shotId = bridge.shotId;
      } catch (_e) { /* context bridging must never block conversation */ }
    }

    const graph = directionImpl.readGraph();
    const summary = directionImpl.summary(graph);
    const partnerMode = graph.project && graph.project.partnerMode || 'suggest';
    const kickstart = looksStuck(message, mode, summary);
    const prompt = buildPrompt({ message, summary, extraContext: resolvedContext, kickstart });
    let rawReply = '';
    try { rawReply = await agentImpl.chat(prompt); } catch (_e) { rawReply = ''; }
    const parsed = parseJsonObject(rawReply);
    const envelope = normalizeEnvelope(parsed, rawReply, { message, summary, kickstart, partnerMode });

    let intent = null;
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
    } catch (_e) { /* chat should never fail because logging failed */ }

    let captured = null;
    try {
      captured = captureInterpretedBeat(directionImpl, envelope, message, resolvedContext, intent);
    } catch (_e) { /* documentation should not break the live creative conversation */ }

    return { ...envelope, intentId: intent ? intent.id : null, captured };
  }

  return { turn };
}

module.exports = {
  BOARD_ACTIONS, parseJsonObject, normalizeNextMoves, normalizeBoardActions,
  looksStuck, kickstartSeed, buildPrompt, captureInterpretedBeat, createPartner,
};
