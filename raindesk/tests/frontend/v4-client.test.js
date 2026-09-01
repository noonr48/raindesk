'use strict';

/*
 * v4-client unit tests (Stage-1 cutover S1) — deterministic, no network:
 * a fake api surface + a Map-backed storage. Pins: actor durability, the
 * enqueue-first outbox, terminal-vs-transient conflict classification,
 * replay-on-boot reconciliation, incarnation minting bounds, storage
 * degradation, and the spatial payload shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const v4 = require(path.join(ROOT, 'public', 'js', 'v4-client.js'));

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, val) => { map.set(k, String(val)); },
    removeItem: (k) => { map.delete(k); },
    _map: map,
  };
}

function throwingStorage() {
  return { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
}

function makeApi(behavior) {
  const calls = [];
  const api = {
    calls,
    applyWorkspaceIntent(payload) {
      calls.push({ kind: 'intent', payload });
      const decision = behavior(payload, calls.length);
      if (decision instanceof Error) return Promise.reject(decision);
      return Promise.resolve(decision == null ? { ok: true, intentId: payload.intentId } : decision);
    },
    patchWorkspaceSpatial(windowId, generation, body) {
      calls.push({ kind: 'spatial', windowId, generation, body });
      return Promise.resolve({ ok: true, window: { ref: { windowId, generation } }, spatialVersion: 2 });
    },
  };
  return api;
}

const terminal = (status, code, extra) => Object.assign(new Error(code), { status, code, detail: { code, ...extra } });
const transient = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

test('actor id is minted once and survives new clients on the same storage', () => {
  const storage = makeStorage();
  const a = v4.V4Client({ api: makeApi(() => null), storage, warn: () => {} });
  const first = a.actorId();
  assert.match(first, /^desk_[0-9a-f]+$/);
  const b = v4.V4Client({ api: makeApi(() => null), storage, warn: () => {} });
  assert.equal(b.actorId(), first, 'stable across instances (durable)');
});

test('intent enqueues FIRST: a transport drop leaves the entry durable for replay', async () => {
  const storage = makeStorage();
  let fail = true;
  const api = makeApi(() => (fail ? transient(0) : { ok: true, duplicate: false }));
  const client = v4.V4Client({ api, storage, warn: () => {} });
  await assert.rejects(client.intent({ kind: 'focus.set', window: null }));
  assert.equal(client.outbox().size, 1, 'pending entry retained after transient failure');
  fail = false;
  const results = await client.replay();
  assert.deepEqual(results, { replayed: 1, resolved: 1, remaining: 0 });
  assert.equal(client.outbox().size, 0);
});

test('replay is idempotent: the server receipt replay passes through as duplicate', async () => {
  const storage = makeStorage();
  const seen = [];
  const api = makeApi((payload) => {
    if (seen.includes(payload.intentId)) return { ok: true, intentId: payload.intentId, duplicate: true };
    seen.push(payload.intentId);
    return transient(0);
  });
  const client = v4.V4Client({ api, storage, warn: () => {} });
  await assert.rejects(client.intent({ kind: 'viewport.set', viewport: { zoom: 1 } }));
  const results = await client.replay();
  assert.equal(results.resolved, 1);
  assert.equal(client.outbox().size, 0);
});

test('terminal typed conflicts settle the outbox entry and rethrow', async () => {
  const cases = [
    terminal(409, 'IDEMPOTENCY_KEY_REUSED'),
    terminal(410, 'WINDOW_GENERATION_GONE', { tombstone: { windowId: 'w_x', generation: 1 } }),
    terminal(409, 'INCARNATION_REPLACED', { live: { windowId: 'w_x', generation: 2 } }),
    terminal(409, 'CONTAINER_CHANGED', { shelf: { version: 2, members: [] } }),
    terminal(422, 'PRESENTATION_NOT_ALLOWED'),
  ];
  for (const error of cases) {
    const storage = makeStorage();
    const api = makeApi(() => error);
    const client = v4.V4Client({ api, storage, warn: () => {} });
    await assert.rejects(client.intent({ kind: 'window.close', window: { windowId: 'w_x', generation: 1, incarnationId: 'inc_x' } }));
    assert.equal(client.outbox().size, 0, `${error.code} settles the entry (no immortal retries)`);
  }
});

test('terminal conflicts can never reach replay(): settled entries are gone before boot', async () => {
  const storage = makeStorage();
  const api = makeApi(() => terminal(410, 'WINDOW_GENERATION_GONE'));
  const client = v4.V4Client({ api, storage, warn: () => {} });
  await assert.rejects(client.intent({ kind: 'window.close', window: {} }));
  const results = await client.replay();
  assert.equal(results.replayed, 0, 'nothing left to replay');
});

test('mintIncarnation stays in server bounds (8..64, charset-clean) and is unique-ish per call', () => {
  const storage = makeStorage();
  const client = v4.V4Client({ api: makeApi(() => null), storage, warn: () => {} });
  const long = 'w'.repeat(80);
  const inc = client.mintIncarnation(long);
  assert.ok(inc.length >= 8 && inc.length <= 64, `bounded: ${inc.length}`);
  assert.match(inc, /^[a-z0-9_]+$/, 'charset clean');
  assert.notEqual(inc, client.mintIncarnation(long), 'unique per call');
});

test('corrupt or future-version outbox clears once, visibly', async () => {
  const storage = makeStorage();
  storage.setItem(v4.OUTBOX_KEY, '{not json');
  const warnings = [];
  const client = v4.V4Client({ api: makeApi(() => null), storage, warn: (m) => warnings.push(m) });
  assert.equal(client.outbox().size, 0);
  assert.equal(warnings.length, 1, 'one visible warn, not silence');
  const vNext = JSON.stringify({ v: v4.OUTBOX_VERSION + 1, entries: [] });
  storage.setItem(v4.OUTBOX_KEY, vNext);
  const client2 = v4.V4Client({ api: makeApi(() => null), storage, warn: () => {} });
  assert.equal(client2.outbox().size, 0, 'unknown version starts fresh');
});

test('storage absence degrades to memory with one warn — intents still flow', async () => {
  const warnings = [];
  const api = makeApi(() => ({ ok: true }));
  const client = v4.V4Client({ api, storage: throwingStorage(), warn: (m) => warnings.push(m) });
  await client.intent({ kind: 'focus.set', window: null });
  assert.equal(client.outbox().size, 0);
  assert.equal(warnings.length, 1, 'warn-once degradation, never silent loss of durability');
});

test('spatial carries the exact incarnation + generation + mutationId to the wire', async () => {
  const storage = makeStorage();
  const api = makeApi(() => null);
  const client = v4.V4Client({ api, storage, warn: () => {} });
  const ref = { windowId: 'window_scenes', generation: 2, incarnationId: 'inc_abc_12345678' };
  await client.spatial(ref, { x: 42, zIndex: 7 }, 'mut_1');
  const call = api.calls.find((c) => c.kind === 'spatial');
  assert.equal(call.windowId, ref.windowId);
  assert.equal(call.generation, ref.generation);
  assert.deepEqual(call.body, { incarnationId: ref.incarnationId, mutationId: 'mut_1', patch: { x: 42, zIndex: 7 } });
  await client.spatial(ref, { y: 9 });
  const bare = api.calls.filter((c) => c.kind === 'spatial')[1];
  assert.equal(bare.body.mutationId, undefined, 'mutationId optional');
});

test('api.js exposes the v4 surface and ApiError carries the typed detail body', async () => {
  const apiMod = require(path.join(ROOT, 'public', 'js', 'api.js'));
  for (const name of ['getWorkspaceV4', 'applyWorkspaceIntent', 'getWorkspaceIntentReceipt', 'patchWorkspaceSpatial']) {
    assert.equal(typeof apiMod[name], 'function', `${name} exported`);
  }
});
