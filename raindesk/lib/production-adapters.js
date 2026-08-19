'use strict';

/**
 * Production Adapter Registry v1
 *
 * Recipes never name concrete tools. Capability Planner asks this registry
 * whether a concrete production path is registered for a stable capability.
 * Descriptors remain data-only; bounded executors resolve their private runtime
 * configuration through the same validated configuration function.
 */

const fs = require('node:fs');
const path = require('node:path');

const ID_RE = /^[a-z][a-z0-9_]{1,95}$/;
const AVAILABILITY = new Set(['available', 'degraded', 'disabled']);
const BOUNDARIES = new Set(['server', 'surface', 'external']);

function text(value, max = 1000) {
  const out = value == null ? '' : String(value).trim();
  return out.length > max ? out.slice(0, max) : out;
}

function textList(value, maxItems = 32, maxLen = 160) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const clean = text(item, maxLen);
    if (clean && !out.includes(clean)) out.push(clean);
    if (out.length >= maxItems) break;
  }
  return out;
}

function assertId(value, what) {
  const id = text(value, 96);
  if (!ID_RE.test(id)) throw new Error(`${what} must match ${ID_RE}`);
  return id;
}

function normalizeDescriptor(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('adapter descriptor must be an object');
  const id = assertId(input.id, 'adapter id');
  const capabilityId = assertId(input.capabilityId, 'capability id');
  const availability = AVAILABILITY.has(input.availability) ? input.availability : 'disabled';
  const invocationBoundary = BOUNDARIES.has(input.invocationBoundary) ? input.invocationBoundary : null;
  if (!invocationBoundary) throw new Error('adapter invocationBoundary must be server, surface, or external');
  const creativeMutation = Boolean(input.creativeMutation);
  const reviewRequired = Boolean(input.reviewRequired);
  if (creativeMutation && !reviewRequired) {
    throw new Error('creative-mutation adapters must require review');
  }
  const priority = Number.isFinite(Number(input.priority)) ? Math.max(-1000, Math.min(1000, Number(input.priority))) : 0;
  return Object.freeze({
    schemaVersion: 1,
    id,
    capabilityId,
    label: text(input.label, 200) || id,
    description: text(input.description, 2000),
    availability,
    invocationBoundary,
    priority,
    creativeMutation,
    reviewRequired,
    requiredEvidence: textList(input.requiredEvidence),
    inputContract: textList(input.inputContract, 64, 200),
    outputContract: textList(input.outputContract, 64, 200),
    preserves: textList(input.preserves, 64, 240),
    sideEffects: textList(input.sideEffects, 32, 240),
    implementationRef: text(input.implementationRef, 4096) || null,
  });
}

function publicDescriptor(adapter) {
  if (!adapter) return null;
  return {
    schemaVersion: adapter.schemaVersion,
    id: adapter.id,
    capabilityId: adapter.capabilityId,
    label: adapter.label,
    description: adapter.description,
    availability: adapter.availability,
    invocationBoundary: adapter.invocationBoundary,
    priority: adapter.priority,
    creativeMutation: adapter.creativeMutation,
    reviewRequired: adapter.reviewRequired,
    requiredEvidence: [...adapter.requiredEvidence],
    inputContract: [...adapter.inputContract],
    outputContract: [...adapter.outputContract],
    preserves: [...adapter.preserves],
    sideEffects: [...adapter.sideEffects],
  };
}

function createRegistry(initial = []) {
  const byId = new Map();

  function register(input) {
    const adapter = normalizeDescriptor(input);
    if (byId.has(adapter.id)) throw new Error(`adapter "${adapter.id}" is already registered`);
    byId.set(adapter.id, adapter);
    return publicDescriptor(adapter);
  }

  function unregister(id) {
    return byId.delete(assertId(id, 'adapter id'));
  }

  function list({ capabilityId = null, includeDisabled = false } = {}) {
    const cap = capabilityId == null ? null : assertId(capabilityId, 'capability id');
    return Array.from(byId.values())
      .filter((adapter) => (!cap || adapter.capabilityId === cap) && (includeDisabled || adapter.availability !== 'disabled'))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
      .map(publicDescriptor);
  }

  function resolve(capabilityId, { allowDegraded = true } = {}) {
    const candidates = list({ capabilityId, includeDisabled: false }).filter((adapter) =>
      adapter.availability === 'available' || (allowDegraded && adapter.availability === 'degraded'));
    return candidates[0] || null;
  }

  function get(id) {
    return publicDescriptor(byId.get(assertId(id, 'adapter id')) || null);
  }

  function getImplementationRef(id) {
    const adapter = byId.get(assertId(id, 'adapter id')) || null;
    return adapter ? adapter.implementationRef : null;
  }

  for (const descriptor of initial) register(descriptor);
  return { register, unregister, list, resolve, get, getImplementationRef };
}

const BUILTIN_ADAPTERS = Object.freeze([
  Object.freeze({
    id: 'bounded_image_region_v1',
    capabilityId: 'local_image_take',
    label: 'Bounded local image take',
    description: 'Existing region+mask generation path that creates an immutable candidate take without replacing accepted artwork.',
    availability: 'available',
    invocationBoundary: 'surface',
    priority: 100,
    creativeMutation: true,
    reviewRequired: true,
    requiredEvidence: ['shot_scope', 'edit_region'],
    inputContract: ['shot_id', 'base_revision_id', 'region_png', 'mask_png', 'prompt'],
    outputContract: ['candidate_take', 'immutable_result_asset'],
    preserves: ['accepted_artwork_until_commit', 'outside_edit_region'],
    sideEffects: ['queues_generation', 'creates_candidate_take'],
    implementationRef: 'api:/api/gen',
  }),
]);

function absoluteExecutable(value) {
  const raw = text(value, 4096);
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return null;
  const resolved = path.resolve(raw);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    fs.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch (_error) {
    return null;
  }
}

function writableProjectRoot(value) {
  const raw = text(value, 4096);
  if (!raw || raw.includes('\0') || !path.isAbsolute(raw)) return null;
  const resolved = path.resolve(raw);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
    fs.accessSync(resolved, fs.constants.W_OK | fs.constants.X_OK);
    return resolved;
  } catch (_error) {
    return null;
  }
}

function configuredAnimaticRuntime(env = process.env) {
  const executable = absoluteExecutable(env && env.RAINDESK_ANIMATIC_EXECUTOR);
  const projectRoot = writableProjectRoot(env && env.RAINDESK_ANIMATIC_PROJECT_ROOT);
  const sourceRights = text(env && env.RAINDESK_SOURCE_RIGHTS, 500);
  if (!executable || !projectRoot || !sourceRights) return null;
  const requestedTimeout = Number(env && env.RAINDESK_ANIMATIC_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(requestedTimeout)
    ? Math.max(5_000, Math.min(30 * 60_000, Math.floor(requestedTimeout)))
    : 15 * 60_000;
  return Object.freeze({ executable, projectRoot, sourceRights, timeoutMs });
}

function configuredAnimaticAdapter(env = process.env) {
  const runtime = configuredAnimaticRuntime(env);
  if (!runtime) return null;
  return Object.freeze({
    id: 'animatic_timing_v1',
    capabilityId: 'animatic_timing',
    label: 'Video-skill animatic timing',
    description: 'Configured external slice-C executor that compiles an immutable SequenceSourceSnapshot into a reviewable animatic candidate.',
    availability: 'available',
    invocationBoundary: 'external',
    priority: 100,
    creativeMutation: true,
    reviewRequired: true,
    requiredEvidence: ['shot_scope'],
    inputContract: ['SequenceSourceSnapshot@0.2.0', 'adapter_id=animatic_timing_v1', 'adapter_contract_version=0.2.0', 'fidelity=draft|preview'],
    outputContract: ['ExecutionAttempt@0.2.0', 'SequenceCandidateManifest@0.2.0', 'animatic_media_artifact'],
    preserves: ['source_snapshot_immutability', 'accepted_artwork', 'review_state_outside_candidate_manifest'],
    sideEffects: ['runs_external_video_executor', 'creates_reviewable_candidate_artifacts'],
    implementationRef: `exec:${runtime.executable}`,
  });
}

function builtinAdapters(env = process.env) {
  const out = [...BUILTIN_ADAPTERS];
  const animatic = configuredAnimaticAdapter(env);
  if (animatic) out.push(animatic);
  return out;
}

function createDefaultRegistry(env = process.env) {
  return createRegistry(builtinAdapters(env));
}

const defaultRegistry = createDefaultRegistry();

module.exports = {
  ID_RE, AVAILABILITY, BOUNDARIES, BUILTIN_ADAPTERS,
  normalizeDescriptor, publicDescriptor, createRegistry,
  absoluteExecutable, writableProjectRoot, configuredAnimaticRuntime,
  configuredAnimaticAdapter, builtinAdapters, createDefaultRegistry, defaultRegistry,
};
