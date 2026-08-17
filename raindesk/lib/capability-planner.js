'use strict';

/**
 * Capability Planner v1
 *
 * Converts stable creative workflow recipes into an honest execution contract.
 * Recipes describe what the artist means; capabilities describe what Raindesk
 * can actually perform today. A recipe name never implies that a production
 * adapter exists.
 */

const CAPABILITY_STATES = new Set(['operational', 'review_take', 'planning_only', 'unavailable']);

const CAPABILITIES = Object.freeze({
  direction_packet: {
    id: 'direction_packet', state: 'operational', phase: 'prepare',
    label: 'Structure directing intent',
    purpose: 'Preserve shot/beat intent, timing, constraints and raw artist wording.',
    executor: 'direction_graph', reversible: true,
  },
  workspace_arrangement: {
    id: 'workspace_arrangement', state: 'operational', phase: 'prepare',
    label: 'Arrange creative workspace',
    purpose: 'Move/focus bounded workspace surfaces without changing creative content.',
    executor: 'workspace', reversible: true,
  },
  reference_evidence: {
    id: 'reference_evidence', state: 'operational', phase: 'prepare',
    label: 'Use pinned reference evidence',
    purpose: 'Carry immutable local reference assets and sheet provenance into a plan.',
    executor: 'sheet_assets', reversible: true,
  },
  identity_authority: {
    id: 'identity_authority', state: 'operational', phase: 'preserve',
    label: 'Preserve explicit character identity',
    purpose: 'Use pinned identity anchors/rules as preservation authority when present, without pretending the pixels were inspected.',
    executor: 'character_registry', reversible: true,
  },
  local_image_take: {
    id: 'local_image_take', state: 'review_take', phase: 'produce',
    label: 'Generate a bounded local visual take',
    purpose: 'Create a candidate edit inside an explicit region while preserving accepted work outside it.',
    executor: 'bounded_image_take', reversible: true,
  },
  take_lifecycle: {
    id: 'take_lifecycle', state: 'operational', phase: 'review',
    label: 'Compare and resolve candidate takes',
    purpose: 'Keep generated alternatives provisional until explicitly accepted/rejected.',
    executor: 'take_store', reversible: true,
  },
  camera_previs: {
    id: 'camera_previs', state: 'planning_only', phase: 'produce',
    label: 'Camera previs',
    purpose: 'Turn camera start/path/landing direction into spatial or temporal camera output.',
    executor: null, reversible: true,
  },
  pose_blocking: {
    id: 'pose_blocking', state: 'planning_only', phase: 'produce',
    label: 'Pose/blocking adapter',
    purpose: 'Produce controllable body poses and transitions from movement intent.',
    executor: null, reversible: true,
  },
  performance_motion: {
    id: 'performance_motion', state: 'planning_only', phase: 'produce',
    label: 'Performance motion adapter',
    purpose: 'Produce controlled face/gaze/mouth/breath acting from performance intent.',
    executor: null, reversible: true,
  },
  contact_geometry: {
    id: 'contact_geometry', state: 'planning_only', phase: 'produce',
    label: 'Contact/action geometry adapter',
    purpose: 'Resolve explicit inter-body contact, side consistency and mechanics.',
    executor: null, reversible: true,
  },
  multi_actor_blocking: {
    id: 'multi_actor_blocking', state: 'planning_only', phase: 'produce',
    label: 'Multi-actor blocking adapter',
    purpose: 'Coordinate several actors through shared space, collision and occlusion.',
    executor: null, reversible: true,
  },
  environment_build: {
    id: 'environment_build', state: 'planning_only', phase: 'produce',
    label: 'Environment construction adapter',
    purpose: 'Produce controllable location/layout/atmosphere changes beyond a bounded image edit.',
    executor: null, reversible: true,
  },
  comic_layout: {
    id: 'comic_layout', state: 'planning_only', phase: 'produce',
    label: 'Comic/page layout adapter',
    purpose: 'Project accepted beats into panel geometry and reading order.',
    executor: null, reversible: true,
  },
  animatic_timing: {
    id: 'animatic_timing', state: 'planning_only', phase: 'produce',
    label: 'Animatic/timing adapter',
    purpose: 'Assemble accepted beats into durations, cuts, holds and sound anchors.',
    executor: null, reversible: true,
  },
  visual_inspection: {
    id: 'visual_inspection', state: 'unavailable', phase: 'inspect',
    label: 'Automatic visual inspection',
    purpose: 'Inspect raw reference pixels and derive visual facts.',
    executor: null, reversible: true,
  },
});

const RECIPE_STAGES = Object.freeze({
  creative_kickstart: [
    ['direction_packet'], ['workspace_arrangement'],
  ],
  local_refinement: [
    ['direction_packet'], ['local_image_take', ['shot_scope', 'edit_region']], ['take_lifecycle'],
  ],
  camera_reveal: [
    ['direction_packet'], ['camera_previs', ['shot_scope', 'start_frame', 'end_frame']],
  ],
  character_motion: [
    ['direction_packet'], ['identity_authority'], ['pose_blocking', ['shot_scope']],
  ],
  performance_closeup: [
    ['direction_packet'], ['identity_authority'], ['performance_motion', ['shot_scope']],
  ],
  contact_action: [
    ['direction_packet'], ['identity_authority'], ['contact_geometry', ['shot_scope', 'multiple_characters']], ['pose_blocking', ['shot_scope']],
  ],
  choreography: [
    ['direction_packet'], ['identity_authority'], ['multi_actor_blocking', ['shot_scope', 'multiple_characters']],
  ],
  environment_establish: [
    ['direction_packet'], ['reference_evidence'], ['environment_build', ['shot_scope']],
  ],
  comic_pacing: [
    ['direction_packet'], ['comic_layout'],
  ],
  animatic_pass: [
    ['direction_packet'], ['animatic_timing', ['shot_scope']],
  ],
});

function isObject(value) { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }

function hasEditRegion(selection) {
  if (!isObject(selection)) return false;
  if (selection.geometry || selection.region || Array.isArray(selection.lasso)) return true;
  return ['lasso', 'region', 'image_region', 'canvas_region'].includes(String(selection.type || ''));
}

function evidence(context = {}) {
  const chars = isObject(context.characterAnchors) && Array.isArray(context.characterAnchors.characters)
    ? context.characterAnchors.characters : [];
  const constraints = isObject(context.directingConstraints) ? context.directingConstraints : {};
  const activeBeat = isObject(context.activeBeat) ? context.activeBeat : {};
  return {
    shot_scope: Boolean(context.shotId || context.legacyShotId),
    edit_region: hasEditRegion(context.selection),
    start_frame: Boolean(constraints.startFrame || activeBeat.startFrame),
    end_frame: Boolean(constraints.endFrame || activeBeat.endFrame),
    character_presence: chars.length > 0,
    multiple_characters: chars.length >= 2,
    locked_identity: chars.some((character) => Boolean(character && character.locked && Array.isArray(character.anchors) && character.anchors.length)),
  };
}

function normalizeWorkflows(workflows) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(workflows) ? workflows : []) {
    const id = typeof item === 'string' ? item : (item && item.id);
    if (!id || !RECIPE_STAGES[id] || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  return out;
}

function stageFor(recipeId, spec, facts, index) {
  const capabilityId = spec[0];
  const requiredEvidence = Array.isArray(spec[1]) ? spec[1] : [];
  const capability = CAPABILITIES[capabilityId];
  if (!capability || !CAPABILITY_STATES.has(capability.state)) return null;
  const missingEvidence = requiredEvidence.filter((key) => !facts[key]);
  let state = capability.state;
  if (missingEvidence.length && ['operational', 'review_take'].includes(state)) state = 'needs_evidence';
  return {
    id: `${recipeId}:${index + 1}:${capabilityId}`,
    recipeId,
    capabilityId,
    label: capability.label,
    purpose: capability.purpose,
    phase: capability.phase,
    state,
    capabilityState: capability.state,
    executor: capability.executor,
    reversible: capability.reversible !== false,
    requiredEvidence,
    missingEvidence,
    reviewRequired: capability.state === 'review_take',
  };
}

function summarizeStatus(stages) {
  if (!stages.length) return 'idle';
  const productive = stages.filter((stage) => stage.phase === 'produce');
  if (stages.some((stage) => stage.state === 'needs_evidence')) return 'needs_evidence';
  if (productive.some((stage) => stage.state === 'unavailable')) return 'blocked';
  if (productive.length && productive.every((stage) => stage.state === 'planning_only')) return 'planning_only';
  if (stages.some((stage) => ['planning_only', 'unavailable'].includes(stage.state))) return 'partial';
  return 'ready';
}

function plan(workflows, { context = {}, permissionMode = 'suggest' } = {}) {
  const recipeIds = normalizeWorkflows(workflows);
  const facts = evidence(context);
  const stages = [];
  for (const recipeId of recipeIds) {
    RECIPE_STAGES[recipeId].forEach((spec, index) => {
      const stage = stageFor(recipeId, spec, facts, index);
      if (stage) stages.push(stage);
    });
  }
  const blockedBy = stages.flatMap((stage) => {
    const items = stage.missingEvidence.map((key) => ({ kind: 'evidence', key, stageId: stage.id }));
    if (stage.state === 'planning_only') items.push({ kind: 'adapter', key: stage.capabilityId, stageId: stage.id });
    if (stage.state === 'unavailable') items.push({ kind: 'capability', key: stage.capabilityId, stageId: stage.id });
    return items;
  });
  const nextExecutable = stages.filter((stage) => ['operational', 'review_take'].includes(stage.state));
  return {
    schemaVersion: 1,
    recipeIds,
    status: summarizeStatus(stages),
    permissionMode: ['watch', 'suggest', 'act'].includes(permissionMode) ? permissionMode : 'suggest',
    canProceed: nextExecutable.length > 0,
    reviewRequired: stages.some((stage) => stage.reviewRequired),
    evidence: facts,
    stages,
    nextExecutable: nextExecutable.map((stage) => stage.id),
    blockedBy,
  };
}

function getCapability(id) { return CAPABILITIES[id] || null; }

module.exports = {
  CAPABILITIES, RECIPE_STAGES, hasEditRegion, evidence, normalizeWorkflows, plan, getCapability,
};
