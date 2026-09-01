'use strict';

/*
 * scope.md criterion 2 (Stage-1 client cutover): "reload with a pending
 * close intent replays the outbox and the closed incarnation never
 * reappears (server readV4 witness)" — the deterministic end-to-end
 * discriminator. Real workspace-v4 store + real V4Client over an in-memory
 * storage standing in for localStorage durability across "reloads".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-v4-outbox-'));
process.env.RAINDESK_DATA_DIR = scratch;

const workspaceV4 = require('../../lib/workspace-v4');
const v4mod = require('../../public/js/v4-client.js');

/** The exact api surface api.js exposes, bound to the REAL v4 store. */
const makeApi = () => ({
  applyWorkspaceIntent: (payload) => Promise.resolve(workspaceV4.applyIntent(payload)),
  patchWorkspaceSpatial: (windowId, generation, body) => Promise.resolve(workspaceV4.applySpatial(windowId, generation, body)),
  getWorkspaceV4: () => Promise.resolve(workspaceV4.readV4()),
});

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}

test('criterion 2: reload with a pending close replays the outbox; the closed incarnation never reappears (readV4 witness)', async () => {
  const storage = memStorage();

  // Seed the window server-side through the real intent lane.
  const seeder = v4mod.V4Client({ api: makeApi(), storage, warn: () => {} });
  const created = await seeder.intent({ kind: 'window.create', windowId: 'window_layers', incarnationId: 'inc_outbox_0001', type: 'layers_panel', x: 10, y: 10, width: 300, height: 200 });
  const ref = created.changed.windows[0].ref;
  assert.ok(workspaceV4.readV4().windows.some((w) => w.ref.windowId === 'window_layers'), 'window live before the close');

  // Session 1 issues the close but the wire DIES (transient) — the entry
  // stays durable in the outbox, exactly like a tab closing mid-request.
  let dead = true;
  const flakyApi = makeApi();
  flakyApi.applyWorkspaceIntent = (payload) => (dead
    ? Promise.reject(Object.assign(new Error('network error'), { status: 0 }))
    : Promise.resolve(workspaceV4.applyIntent(payload)));
  const session1 = v4mod.V4Client({ api: flakyApi, storage, warn: () => {} });
  await assert.rejects(session1.intent({ kind: 'window.close', window: { ...ref } }));
  assert.equal(session1.outbox().size, 1, 'pending close is durable after the transport drop');
  assert.ok(workspaceV4.readV4().windows.some((w) => w.ref.windowId === 'window_layers'), 'server still holds the row (the close never landed)');

  // "Reload": a FRESH client over the same storage replays before restore.
  dead = false;
  const session2 = v4mod.V4Client({ api: makeApi(), storage, warn: () => {} });
  assert.equal(session2.outbox().size, 1, 'the pending close survived the reload');
  const results = await session2.replay();
  assert.deepEqual(results, { replayed: 1, resolved: 1, remaining: 0 });

  // Server witness: the incarnation is tombstoned and NEVER reappears.
  const after = workspaceV4.readV4();
  assert.ok(!after.windows.some((w) => w.ref.windowId === 'window_layers'), 'closed incarnation gone from readV4');
  assert.equal(after.tombstones.window_layers.incarnationId, 'inc_outbox_0001', 'tombstone pins the exact incarnation');
  assert.throws(() => workspaceV4.assertLegacyWriteAllowed('window_layers'), (e) => e.status === 410 && e.code === 'WINDOW_GENERATION_GONE',
    'a stale legacy upsert cannot resurrect it either');
});
