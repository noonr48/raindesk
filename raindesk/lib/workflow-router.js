'use strict';

/**
 * Capability-level workflow router.
 *
 * This file intentionally knows NOTHING about a specific model/node graph.
 * It maps artist intent to stable production recipes; adapters can later map
 * those recipe steps to whatever image/pose/camera/motion tools are current.
 */

const RECIPES = {
  creative_kickstart: {
    id: 'creative_kickstart',
    label: 'Get moving',
    purpose: 'Break a blank/frozen moment into one low-commitment creative move.',
    passes: ['pick one visible moment', 'offer 2-3 rough directions', 'place temporary cards', 'ask for reaction, not a specification'],
    preserve: ['all existing accepted work'],
  },
  local_refinement: {
    id: 'local_refinement',
    label: 'Local visual refinement',
    purpose: 'Change one bounded visual region while protecting the rest.',
    passes: ['identify edit region', 'define preserve boundary', 'make local edit', 'compare take', 'accept or branch'],
    preserve: ['unselected composition', 'identity unless explicitly changed'],
  },
  camera_reveal: {
    id: 'camera_reveal',
    label: 'Camera move / reveal',
    purpose: 'Translate start/end framing and camera-path direction into a rough shot move.',
    passes: ['anchor start frame', 'anchor landing frame', 'interpret camera path', 'rough previs', 'review framing and continuity', 'time the move'],
    preserve: ['accepted staging', 'character identity', 'scene geography'],
  },
  character_motion: {
    id: 'character_motion',
    label: 'Character movement beat',
    purpose: 'Turn a gesture or body movement into clear blocking, timing and follow-through without overbuilding the shot.',
    passes: ['anchor starting pose', 'trace the primary motion path', 'check weight/body mechanics', 'set timing and overlap', 'add secondary motion', 'review camera relationship'],
    preserve: ['character identity', 'accepted scene geography', 'unrelated body/action beats'],
  },
  performance_closeup: {
    id: 'performance_closeup',
    label: 'Performance close-up',
    purpose: 'Develop subtle face, gaze, mouth, breath and dialogue acting.',
    passes: ['define emotional progression', 'anchor dialogue/sound', 'key expressions', 'head/eye/mouth motion', 'review subtlety and identity'],
    preserve: ['identity', 'accepted framing', 'costume'],
  },
  contact_action: {
    id: 'contact_action',
    label: 'Contact action',
    purpose: 'Build punches, catches, grabs, impacts or body contacts without losing mechanics.',
    passes: ['block geography', 'define contact point', 'anticipation pose', 'contact pose', 'follow-through', 'camera/timing pass', 'continuity review'],
    preserve: ['participants', 'contact-side consistency', 'scene geography'],
  },
  choreography: {
    id: 'choreography',
    label: 'Multi-character choreography',
    purpose: 'Coordinate several moving characters through a spatial action sequence.',
    passes: ['scene geography', 'individual action paths', 'contact relationships', 'occlusion/collision review', 'camera selection', 'beat timing'],
    preserve: ['character identity', 'location continuity'],
  },
  environment_establish: {
    id: 'environment_establish',
    label: 'Environment establishment',
    purpose: 'Develop location, scale, atmosphere and traversal before polishing detail.',
    passes: ['composition variants', 'environment continuity', 'camera/staging', 'atmospheric motion', 'character insertion'],
    preserve: ['location rules', 'accepted landmarks'],
  },
  comic_pacing: {
    id: 'comic_pacing',
    label: 'Comic pacing pass',
    purpose: 'Project story beats into panel choice, scale, page rhythm and reading order.',
    passes: ['choose beat moments', 'arrange panel rhythm', 'test reading path', 'vary panel sizes', 'review emotional pacing'],
    preserve: ['story beats', 'dialogue meaning'],
  },
  animatic_pass: {
    id: 'animatic_pass',
    label: 'Animatic pass',
    purpose: 'Project accepted shot intent into rough durations, cuts, holds and sound anchors.',
    passes: ['collect accepted shot beats', 'assign provisional timing', 'assemble sequence', 'review rhythm', 'revise holds/cuts'],
    preserve: ['accepted shot order unless explicitly exploring', 'dialogue anchors'],
  },
};

const HINTS = [
  ['camera_reveal', /\b(camera|cam|orbit|spiral|push in|push-in|pull back|dolly|pan|tilt|crane|zoom|frame lands|start frame|end frame)\b/i],
  ['character_motion', /\b(move|moves|moving|step|steps|turn|turns|raise|raises|lower|lowers|shake|shakes|fist|stand|stands|sit|sits|lean|leans|reach|reaches|walk|walks|run|runs|recoil|crouch|jump|gesture|point|points|swing|swings|twist|twists|shift|shifts|lunge|lunges)\b/i],
  ['contact_action', /\b(punch|kick|hit|impact|grab|grabs|catch|catches|wrist|contact|collide|slam|strike|block)\b/i],
  ['performance_closeup', /\b(expression|facial|eyes|gaze|mouth|tongue|breath|speaks|says|dialogue|smile|frown|anger|hesitat|reaction)\b/i],
  ['choreography', /\b(fight|choreograph|two people|both characters|crowd|dance|crossing|multi-character|multiple characters)\b/i],
  ['comic_pacing', /\b(comic|page|panel|gutter|reading order|page turn|manga)\b/i],
  ['animatic_pass', /\b(animatic|timing|duration|hold|frames|seconds|cut|sound|sfx|music)\b/i],
  ['environment_establish', /\b(environment|location|establish|landscape|weather|world|street|room|rooftop|mountain|forest|city)\b/i],
  ['local_refinement', /\b(move (the )?(hand|head|arm|leg)|only change|keep everything|preserve|small change|local edit|lasso|inpaint|adjust)\b/i],
];

function asText(intent) {
  if (typeof intent === 'string') return intent;
  if (!intent || typeof intent !== 'object') return '';
  const parts = [intent.raw, intent.message, intent.description, intent.kind];
  if (intent.interpretation && typeof intent.interpretation === 'object') {
    // Curated fields only: preserve words describe what must NOT change, so
    // feeding the whole interpretation JSON pulls noise recipes.
    const curated = intent.interpretation;
    for (const key of ['kind', 'editScope', 'movement', 'dialogue', 'camera']) {
      const value = curated[key];
      if (typeof value === 'string' && value.trim()) parts.push(value);
      else if (value && typeof value === 'object') parts.push(JSON.stringify(value));
    }
  }
  return parts.filter(Boolean).join(' ');
}

function rankRecipes(intent, { kickstart = false, limit = 3 } = {}) {
  const text = asText(intent);
  const scored = [];
  if (kickstart) scored.push({ id: 'creative_kickstart', score: 100, reason: 'artist needs a low-friction starting move' });
  for (const [id, re] of HINTS) {
    if (re.test(text)) scored.push({ id, score: 10, reason: `intent matches ${RECIPES[id].label.toLowerCase()}` });
  }
  if (!scored.length && text.trim()) {
    scored.push({ id: 'local_refinement', score: 1, reason: 'safe generic reversible pass' });
  }
  const seen = new Set();
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((x) => !seen.has(x.id) && seen.add(x.id))
    .slice(0, limit)
    .map((x) => ({ ...RECIPES[x.id], reason: x.reason }));
}

function getRecipe(id) { return RECIPES[id] || null; }

module.exports = { RECIPES, rankRecipes, getRecipe };
