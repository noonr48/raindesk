'use strict';

/**
 * Adapter-aware Capability Planner composition.
 *
 * capability-planner-core.js owns recipe/evidence/permission semantics.
 * This layer is the only place that upgrades a production capability from its
 * fallback state after resolving a concrete registered adapter.
 */

const core = require('./capability-planner-core');
const adapters = require('./production-adapters');
const { summarizeStatus } = core;

const ADAPTER_DRIVEN = new Set([
  'local_image_take', 'camera_previs', 'pose_blocking', 'performance_motion',
  'contact_geometry', 'multi_actor_blocking', 'environment_build', 'comic_layout',
  'animatic_timing', 'visual_inspection',
]);

const FALLBACK_STATE = Object.freeze({
  local_image_take: 'planning_only',
  camera_previs: 'planning_only',
  pose_blocking: 'planning_only',
  performance_motion: 'planning_only',
  contact_geometry: 'planning_only',
  multi_actor_blocking: 'planning_only',
  environment_build: 'planning_only',
  comic_layout: 'planning_only',
  animatic_timing: 'planning_only',
  visual_inspection: 'unavailable',
});

function adapterSummary(adapter) {
  if (!adapter) return null;
  return {
    id: adapter.id,
    capabilityId: adapter.capabilityId,
    label: adapter.label,
    availability: adapter.availability,
    invocationBoundary: adapter.invocationBoundary,
    creativeMutation: Boolean(adapter.creativeMutation),
    reviewRequired: Boolean(adapter.reviewRequired),
    requiredEvidence: Array.isArray(adapter.requiredEvidence) ? [...adapter.requiredEvidence] : [],
  };
}

function capabilityState(capabilityId, registry = adapters.defaultRegistry) {
  const base = core.getCapability(capabilityId);
  if (!base) return null;
  if (!ADAPTER_DRIVEN.has(capabilityId)) return { ...base, adapter: null };
  const adapter = registry && typeof registry.resolve === 'function' ? registry.resolve(capabilityId) : null;
  if (!adapter) {
    return {
      ...base,
      state: FALLBACK_STATE[capabilityId] || 'planning_only',
      executor: null,
      adapter: null,
    };
  }
  const state = adapter.reviewRequired ? 'review_take' : 'operational';
  return {
    ...base,
    state,
    // Surface/external adapters exist, but are not direct server executors.
    executor: adapter.invocationBoundary === 'server' ? adapter.id : null,
    adapter: adapterSummary(adapter),
  };
}

function rebuildPlan(basePlan, registry) {
  const mode = basePlan.permissionMode;
  const stages = basePlan.stages.map((stage) => {
    if (!ADAPTER_DRIVEN.has(stage.capabilityId)) return { ...stage };
    const capability = capabilityState(stage.capabilityId, registry);
    if (!capability) return { ...stage };
    const requiredEvidence = Array.from(new Set([
      ...(Array.isArray(stage.requiredEvidence) ? stage.requiredEvidence : []),
      ...(capability.adapter && Array.isArray(capability.adapter.requiredEvidence) ? capability.adapter.requiredEvidence : []),
    ]));
    const missingEvidence = requiredEvidence.filter((key) => !basePlan.evidence[key]);
    let state = capability.state;
    if (missingEvidence.length && ['operational', 'review_take'].includes(state)) state = 'needs_evidence';
    return {
      ...stage,
      state,
      capabilityState: capability.state,
      executor: capability.executor,
      adapter: capability.adapter,
      requiredEvidence,
      missingEvidence,
      reviewRequired: capability.state === 'review_take',
      disposition: core.permissionDisposition(capability, state, mode),
    };
  });

  const blockedBy = stages.flatMap((stage) => {
    const items = stage.missingEvidence.map((key) => ({ kind: 'evidence', key, stageId: stage.id }));
    if (stage.state === 'planning_only') items.push({ kind: 'adapter', key: stage.capabilityId, stageId: stage.id });
    if (stage.state === 'unavailable') items.push({ kind: 'capability', key: stage.capabilityId, stageId: stage.id });
    return items;
  });
  const available = stages.filter((stage) => ['operational', 'review_take'].includes(stage.state));
  if (mode === 'watch' && available.length) blockedBy.push({ kind: 'permission', key: 'watch', stageId: null });
  const hasExecutableProductionStage = stages.some((stage) => stage.phase === 'produce'
    && ['operational', 'review_take'].includes(stage.state)
    && ['proposal', 'auto'].includes(stage.disposition));
  const preparatoryOnly = stages.length > 0 && !stages.some((stage) => stage.phase === 'produce');

  return {
    ...basePlan,
    status: summarizeStatus(stages),
    hasExecutableProductionStage,
    preparatoryOnly,
    canProceed: mode !== 'watch' && available.length > 0,
    reviewRequired: stages.some((stage) => stage.reviewRequired),
    stages,
    availableStages: available.map((stage) => stage.id),
    autoExecutable: stages.filter((stage) => stage.disposition === 'auto').map((stage) => stage.id),
    reviewableStages: stages.filter((stage) => stage.capabilityState === 'review_take' && stage.state !== 'needs_evidence').map((stage) => stage.id),
    blockedBy,
  };
}

function plan(workflows, { context = {}, permissionMode = 'suggest', adapterRegistry = adapters.defaultRegistry } = {}) {
  const basePlan = core.plan(workflows, { context, permissionMode });
  return rebuildPlan(basePlan, adapterRegistry);
}

function getCapability(id, { adapterRegistry = adapters.defaultRegistry } = {}) {
  return capabilityState(id, adapterRegistry);
}

const CAPABILITIES = Object.freeze(Object.fromEntries(
  Object.keys(core.CAPABILITIES).map((id) => [id, Object.freeze(getCapability(id))]),
));

module.exports = {
  ...core,
  CAPABILITIES,
  ADAPTER_DRIVEN,
  FALLBACK_STATE,
  adapterSummary,
  capabilityState,
  rebuildPlan,
  plan,
  getCapability,
};
