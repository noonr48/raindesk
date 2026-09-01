'use strict';

/*
 * Adapter-family impl-repair discriminators (implementation-lens findings):
 * (1) a v3-refusing object payload leaves BOTH stores untouched (no v4-only
 *     half-serve); (2) the synthetic create carries space + entityRef from
 *     the v3 row; (3) a ghost-group 400 leaves v4 groups untouched; (4) a
 *     cross-group swap with destination-before-source mirrors cleanly
 *     (order-insensitive two-pass); (5) the object route couples
 *     legacyRevision; (6) geometry mirrors the v3 CLAMPED values.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-adapter-repair-'));
process.env.RAINDESK_DATA_DIR = scratch;

const { createServer } = require('../../server');
const workspaceV4 = require('../../lib/workspace-v4');
const workspaceV3 = require('../../lib/workspace');

let server; let port;
test.before(async () => {
  server = createServer({});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});
test.after(() => new Promise((resolve) => server.close(resolve)));

const post = async (route, body) => {
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('repair F1: a v3-refusing object payload (unknown type) leaves BOTH stores untouched — no unrepairable v4-only row', async () => {
  const { status } = await post('/api/workspace/object', { id: 'world_bogus', type: 'not_a_real_type', x: 0, y: 0, width: 100, height: 80 });
  assert.equal(status, 400, 'v3 rejects the unknown type');
  assert.ok(!workspaceV4.read().windows.some((w) => w.ref.windowId === 'world_bogus'), 'NO v4 row (the old v4-first order left one permanently)');
  assert.ok(!workspaceV3.read().windows.some((w) => w.windowId === 'world_bogus'), 'no v3 row either');
});

test('repair F2: the synthetic create carries space + entityRef from the v3 row', async () => {
  const { status } = await post('/api/workspace/object', { id: 'world_art2', type: 'sheet', entityRef: 'sheet:art2', x: 10, y: 20, width: 300, height: 200 });
  assert.equal(status, 200);
  const row = workspaceV4.read().windows.find((w) => w.ref.windowId === 'world_art2');
  assert.ok(row, 'v4 row created');
  assert.equal(row.space, 'world', 'space derived BY V3 (sheet -> world), not the v4 screen default');
  assert.equal(row.entityRef, 'sheet:art2', 'entityRef carried from the v3 row');
});

test('repair F3: a ghost-group 400 leaves v4 groups untouched (the old order dissolved them first)', async () => {
  await post('/api/workspace/object', { id: 'world_gr1', type: 'note', x: 0, y: 0, width: 100, height: 80 });
  await post('/api/workspace/object', { id: 'world_gr2', type: 'note', x: 200, y: 0, width: 100, height: 80 });
  let r = await post('/api/workspace/groups', { groups: [{ groupId: 'g_alive', windowIds: ['world_gr1', 'world_gr2'], activeWindowId: 'world_gr1' }] });
  assert.equal(r.status, 200);
  const before = JSON.stringify(workspaceV4.read().groups.map((g) => g.groupId));
  r = await post('/api/workspace/groups', { groups: [{ groupId: 'g_ghost', windowIds: ['no_such_window'] }] });
  assert.equal(r.status, 400, 'the ghost reference is a v3-style 400');
  const after = JSON.stringify(workspaceV4.read().groups.map((g) => g.groupId));
  assert.equal(after, before, `v4 groups UNTOUCHED by the refused payload (${before} -> ${after})`);
});

test('repair F4: cross-group swap with destination-before-source mirrors cleanly (order-insensitive)', async () => {
  let r = await post('/api/workspace/groups', { groups: [
    { groupId: 'g_src', windowIds: ['world_gr1'], activeWindowId: 'world_gr1' },
    { groupId: 'g_dst', windowIds: ['world_gr2'], activeWindowId: 'world_gr2' },
  ] });
  assert.equal(r.status, 200);
  // destination precedes source in the payload; both members move across
  r = await post('/api/workspace/groups', { groups: [
    { groupId: 'g_dst', windowIds: ['world_gr1'], activeWindowId: 'world_gr1' },
    { groupId: 'g_src', windowIds: ['world_gr2'], activeWindowId: 'world_gr2' },
  ] });
  assert.equal(r.status, 200, `the swap succeeded (got ${r.status}: ${JSON.stringify(r.json && r.json.error)})`);
  const doc = workspaceV4.read();
  assert.deepEqual(doc.groups.find((g) => g.groupId === 'g_dst').members.map((m) => m.windowId), ['world_gr1']);
  assert.deepEqual(doc.groups.find((g) => g.groupId === 'g_src').members.map((m) => m.windowId), ['world_gr2']);
});

test('repair F5+G: the object route couples legacyRevision and mirrors v3-CLAMPED geometry', async () => {
  const { status, json } = await post('/api/workspace/object', { id: 'world_tiny', type: 'note', x: 5, y: 5, width: 5, height: 5 });
  assert.equal(status, 200);
  assert.equal(json.legacyRevision, workspaceV3.read().revision, 'legacyRevision fresh (coupled on the object route)');
  const row = workspaceV4.read().windows.find((w) => w.ref.windowId === 'world_tiny');
  const v3row = workspaceV3.read().windows.find((w) => w.windowId === 'world_tiny');
  assert.equal(row.spatial.width, Math.round(v3row.width), 'the v4 mirror carries the v3 CLAMPED width (v3 floors tiny windows), not the raw 5');
});
