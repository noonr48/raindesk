'use strict';

/*
 * Adapter-family A3 — the legacy structural routes as v4 diff-to-intent
 * adapters (Round-6 §6): the requested diff lands in v4 FIRST (canonical),
 * the v3 write follows as the projection, legacyRevision stays coupled, and
 * responses carry deprecation metadata.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-legacy-structural-'));
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
const seed = async (id) => post('/api/workspace/object', { id, type: 'note', x: 0, y: 0, width: 200, height: 150 });

test('A3 groups: the requested diff lands in v4 (create -> leave -> dissolve) with deprecation metadata', async () => {
  await seed('world_g1'); await seed('world_g2'); await seed('world_g3');
  let r = await post('/api/workspace/groups', { groups: [{ groupId: 'g_x', windowIds: ['world_g1', 'world_g2', 'world_g3'], activeWindowId: 'world_g2' }] });
  assert.equal(r.status, 200, `group create ok (${JSON.stringify(r.json && r.json.error)})`);
  assert.equal(r.json.deprecated, true, 'deprecation metadata present');
  assert.equal(r.json.use, '/api/workspace/v4');
  let g = workspaceV4.read().groups.find((x) => x.groupId === 'g_x');
  assert.ok(g, 'the v4 group exists');
  assert.deepEqual(g.members.map((m) => m.windowId), ['world_g1', 'world_g2', 'world_g3']);
  assert.equal(g.active.windowId, 'world_g2');

  r = await post('/api/workspace/groups', { groups: [{ groupId: 'g_x', windowIds: ['world_g1'], activeWindowId: 'world_g1' }] });
  assert.equal(r.status, 200);
  g = workspaceV4.read().groups.find((x) => x.groupId === 'g_x');
  assert.deepEqual(g.members.map((m) => m.windowId), ['world_g1'], 'leave diff shrank the v4 membership');

  r = await post('/api/workspace/groups', { groups: [] });
  assert.equal(r.status, 200);
  assert.ok(!workspaceV4.read().groups.some((x) => x.groupId === 'g_x'), 'the empty request dissolved the v4 group');
});

test('A3 shelf: adds minimise and removes restore in v4; legacyRevision tracks the v3 revision', async () => {
  await seed('world_s1'); await seed('world_s2');
  let r = await post('/api/workspace/shelf', { windowIds: ['world_s1', 'world_s2'] });
  assert.equal(r.status, 200);
  let v4shelf = workspaceV4.read().shelf.members.map((m) => m.windowId);
  assert.deepEqual(v4shelf.sort(), ['world_s1', 'world_s2'], 'both members minimised in v4');
  assert.equal(workspaceV4.read().legacyRevision, workspaceV3.read().revision, 'legacyRevision coupled to the v3 revision');

  r = await post('/api/workspace/shelf', { windowIds: ['world_s2'] });
  assert.equal(r.status, 200);
  v4shelf = workspaceV4.read().shelf.members.map((m) => m.windowId);
  assert.deepEqual(v4shelf, ['world_s2'], 'restore diff removed world_s1 from the v4 shelf');
  assert.equal(workspaceV4.read().legacyRevision, workspaceV3.read().revision, 'coupling held after the second write');
});

test('A3 delete: the v4 row tombstones (identity-exact) and the legacy route stays gated on stale revisions', async () => {
  await seed('world_d1');
  const stale = workspaceV3.read().revision - 1;
  let r = await post('/api/workspace/window/delete', { windowId: 'world_d1', baseRevision: stale });
  assert.equal(r.status, 409, 'stale baseRevision still conflicts');
  assert.match(r.json.error, /changed since/);
  assert.ok(r.json.workspace, 'the 409 carries the current state');

  r = await post('/api/workspace/window/delete', { windowId: 'world_d1' });
  assert.equal(r.status, 200);
  assert.ok(!workspaceV3.read().windows.some((w) => w.windowId === 'world_d1'), 'v3 row gone');
  const doc = workspaceV4.read();
  assert.ok(!doc.windows.some((w) => w.ref.windowId === 'world_d1'), 'v4 row gone');
  assert.ok(doc.tombstones['world_d1'], 'v4 tombstone recorded — the id can never resurrect through any route');
});
