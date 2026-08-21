'use strict';

/*
 * Deterministic route tests for the freeform desk's structural workspace API:
 * POST /api/workspace/groups, /api/workspace/shelf, /api/workspace/window/delete —
 * revision-gated (baseRevision -> 409 + current workspace), whitelist-validated,
 * referentially consistent. The lib-level behaviour is covered in
 * workspace.test.js; these prove the HTTP surface end to end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-workspace-routes-'));
process.env.RAINDESK_DATA_DIR = scratch;

const { createServer } = require('../../server');

async function withServer(t, fn) {
  const server = createServer({ partnerImpl: { turn: async () => ({ message: 'unused', invocationRequests: [] }) } });
  const sockets = new Set();
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  t.after(() => new Promise((r) => { server.close(() => r()); for (const s of sockets) s.destroy(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };
const post = (base, route, payload) => fetch(`${base}${route}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(payload) });
const getWorkspace = async (base) => (await (await fetch(`${base}/api/workspace`)).json());

test('workspace group/shelf/delete routes round-trip with revision gating', async (t) => {
  await withServer(t, async (base) => {
    // Seed two windows through the existing object route.
    for (const [windowId, ref] of [['window_alpha', 'note:alpha'], ['window_beta', 'note:beta']]) {
      const res = await post(base, '/api/workspace/object', { windowId, type: 'note', entityRef: ref, x: 0, y: 0, width: 220, height: 160 });
      assert.equal(res.status, 200, `seed ${windowId}`);
    }
    let ws = await getWorkspace(base);
    assert.equal(ws.windows.length, 2);
    assert.ok(ws.revision >= 1, 'revision exposed to clients');

    // Group them with the fresh revision.
    let res = await post(base, '/api/workspace/groups', {
      groups: [{ groupId: 'group_ab', windowIds: ['window_alpha', 'window_beta'], activeWindowId: 'window_beta' }],
      baseRevision: ws.revision,
    });
    assert.equal(res.status, 200);
    ws = (await res.json()).workspace;
    assert.equal(ws.windows.find((w) => w.windowId === 'window_alpha').groupId, 'group_ab');
    assert.equal(ws.groups[0].activeWindowId, 'window_beta');

    // Shelf one member with the fresh revision.
    const fresh = (await getWorkspace(base)).revision;
    res = await post(base, '/api/workspace/shelf', { windowIds: ['window_beta'], baseRevision: fresh });
    assert.equal(res.status, 200);
    ws = (await res.json()).workspace;
    assert.deepEqual(ws.shelf.windowIds, ['window_beta']);
    assert.equal(ws.windows.find((w) => w.windowId === 'window_beta').state, 'minimised', 'shelving minimises the member');

    // Stale baseRevision -> 409 with the current workspace attached.
    res = await post(base, '/api/workspace/groups', { groups: [], baseRevision: fresh });
    assert.equal(res.status, 409);
    const conflict = await res.json();
    assert.match(conflict.error, /changed since/);
    assert.ok(conflict.workspace && Array.isArray(conflict.workspace.windows), '409 carries the current state for retry');

    // Delete cascade: removing a member keeps the group with the survivor;
    // the mission guarantees closing one tab never destroys the others.
    const now = (await getWorkspace(base)).revision;
    res = await post(base, '/api/workspace/window/delete', { windowId: 'window_beta', baseRevision: now });
    assert.equal(res.status, 200);
    ws = (await res.json()).workspace;
    assert.equal(ws.windows.length, 1);
    assert.deepEqual(ws.groups[0].windowIds, ['window_alpha'], 'group survives the loss of one member');
    assert.deepEqual(ws.shelf.windowIds, [], 'shelf membership cleaned on delete');
    // Deleting the LAST member dissolves the group.
    const last = (await getWorkspace(base)).revision;
    res = await post(base, '/api/workspace/window/delete', { windowId: 'window_alpha', baseRevision: last });
    ws = (await res.json()).workspace;
    assert.equal(ws.groups.length, 0, 'group dissolves when the last member leaves');
  });
});

test('workspace structural routes reject malformed payloads and unknown windows', async (t) => {
  await withServer(t, async (base) => {
    let res = await post(base, '/api/workspace/groups', { groups: [{ groupId: 'ghost', windowIds: ['no_such_window'] }] });
    assert.equal(res.status, 400, 'group referencing an unknown window is rejected');
    res = await post(base, '/api/workspace/shelf', {});
    assert.equal(res.status, 400, 'shelf without windowIds is rejected');
    res = await post(base, '/api/workspace/window/delete', { windowId: 'missing_window' });
    assert.equal(res.status, 404, 'deleting an unknown window is a 404');
    res = await post(base, '/api/workspace/groups', { groups: 'not-an-array' });
    assert.equal(res.status, 400, 'non-array groups payload is rejected');
  });
});
