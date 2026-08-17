'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const adapters = require('../production-adapters');

test('built-in bounded image adapter describes a reviewable surface production path', () => {
  const adapter = adapters.defaultRegistry.resolve('local_image_take');
  assert.ok(adapter);
  assert.equal(adapter.id, 'bounded_image_region_v1');
  assert.equal(adapter.availability, 'available');
  assert.equal(adapter.invocationBoundary, 'surface');
  assert.equal(adapter.creativeMutation, true);
  assert.equal(adapter.reviewRequired, true);
  assert.ok(adapter.requiredEvidence.includes('edit_region'));
  assert.ok(adapter.outputContract.includes('candidate_take'));
});

test('creative mutation adapter cannot register without mandatory review', () => {
  assert.throws(() => adapters.normalizeDescriptor({
    id: 'unsafe_image_v1', capabilityId: 'local_image_take', availability: 'available',
    invocationBoundary: 'server', creativeMutation: true, reviewRequired: false,
  }), /must require review/);
});

test('registry rejects duplicate adapter ids and resolves deterministically by priority then id', () => {
  const registry = adapters.createRegistry();
  registry.register({
    id: 'pose_b', capabilityId: 'pose_blocking', availability: 'available', invocationBoundary: 'server',
    priority: 10, creativeMutation: true, reviewRequired: true,
  });
  registry.register({
    id: 'pose_a', capabilityId: 'pose_blocking', availability: 'available', invocationBoundary: 'server',
    priority: 20, creativeMutation: true, reviewRequired: true,
  });
  assert.equal(registry.resolve('pose_blocking').id, 'pose_a');
  assert.throws(() => registry.register({
    id: 'pose_a', capabilityId: 'pose_blocking', availability: 'available', invocationBoundary: 'server',
    creativeMutation: true, reviewRequired: true,
  }), /already registered/);
});

test('public registry projections never carry the internal implementationRef', () => {
  const registry = adapters.createRegistry([{
    id: 'ref_carrying_v1', capabilityId: 'local_image_take', availability: 'available',
    invocationBoundary: 'surface', creativeMutation: true, reviewRequired: true,
    implementationRef: 'internal://executor/secret-adapter',
  }]);
  const fromRegister = registry.register({
    id: 'ref_carrying_v2', capabilityId: 'pose_blocking', availability: 'available',
    invocationBoundary: 'server', creativeMutation: true, reviewRequired: true,
    implementationRef: 'internal://executor/secret-adapter-2',
  });
  const fromResolve = registry.resolve('local_image_take');
  const fromList = registry.list().find((item) => item.id === 'ref_carrying_v1');
  const fromGet = registry.get('ref_carrying_v1');
  const projections = [fromRegister, fromResolve, fromList, fromGet];
  for (const projection of projections) {
    assert.ok(projection);
    assert.equal(Object.prototype.hasOwnProperty.call(projection, 'implementationRef'), false);
  }
});

test('disabled adapters are retained for diagnostics but never resolve as available', () => {
  const registry = adapters.createRegistry([{
    id: 'camera_disabled_v1', capabilityId: 'camera_previs', availability: 'disabled', invocationBoundary: 'external',
    creativeMutation: true, reviewRequired: true,
  }]);
  assert.equal(registry.resolve('camera_previs'), null);
  assert.equal(registry.list().length, 0);
  assert.equal(registry.list({ includeDisabled: true })[0].availability, 'disabled');
});

test('adapter public descriptor is data-only and never exposes executable callback objects', () => {
  const registry = adapters.createRegistry([{
    id: 'external_motion_v1', capabilityId: 'performance_motion', availability: 'degraded', invocationBoundary: 'external',
    creativeMutation: true, reviewRequired: true, implementationRef: 'connector:motion-tool',
  }]);
  const descriptor = registry.resolve('performance_motion');
  assert.equal(typeof descriptor, 'object');
  assert.equal(Object.values(descriptor).some((value) => typeof value === 'function'), false);
});
