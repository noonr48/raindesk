'use strict';

/*
 * Adapter-family A2 — the legacy object route as a v4 compatibility ADAPTER
 * (Round-6 §6): window_* namespace reserved (410), missing legacy ids create
 * generation 1 through a synthetic v4 intent (row lands in BOTH stores), live
 * updates land in v4 spatially, and responses carry legacyRevision.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-legacy-object-'));
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

async function postObject(body) {
  const res = await fetch(`http://127.0.0.1:${port}/api/workspace/object`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('A2 rule 1: missing window_* ids are reserved — 410 WINDOW_NAMESPACE_RESERVED, nothing created', async () => {
  const { status, json } = await postObject({ id: 'window_should_not_exist', x: 10, y: 10, width: 100, height: 80 });
  assert.equal(status, 410, `window_* missing -> 410 (got ${status}: ${JSON.stringify(json)})`);
  assert.equal(json && json.code, 'WINDOW_NAMESPACE_RESERVED', 'typed envelope, not a bare message');
  const v4doc = workspaceV4.read();
  assert.ok(!v4doc.windows.some((w) => w.ref.windowId === 'window_should_not_exist'), 'no v4 row');
  assert.ok(!workspaceV3.read().windows.some((w) => w.windowId === 'window_should_not_exist'), 'no v3 row either');
});

test('A2 rule 2: missing legacy ids create generation 1 through a synthetic v4 intent — the row lands in BOTH stores', async () => {
  const { status, json } = await postObject({ id: 'world_art_board', type: 'sheet', x: 12, y: 34, width: 400, height: 300 });
  assert.equal(status, 200, `legacy create succeeded (got ${status}: ${JSON.stringify(json)})`);
  assert.ok(json && Number.isFinite(json.legacyRevision), 'the response carries legacyRevision');
  const v4doc = workspaceV4.read();
  const row = v4doc.windows.find((w) => w.ref.windowId === 'world_art_board');
  assert.ok(row, 'the v4 store has the row');
  assert.equal(row.ref.generation, 1, 'generation 1');
  assert.ok(row.ref.incarnationId, 'persisted incarnation id');
  assert.equal(row.type, 'sheet', 'the v4-valid type mapped through');
  assert.ok(workspaceV3.read().windows.some((w) => w.windowId === 'world_art_board'), 'the v3 store has the row too (one request, both stores)');
});

test('A2 rule 3: live legacy row updates land in v4 SPATIALLY too (no silent mirror gap)', async () => {
  const { status } = await postObject({ id: 'world_art_board', x: 100, y: 200, width: 420, height: 310, zIndex: 7 });
  assert.equal(status, 200);
  const row = workspaceV4.read().windows.find((w) => w.ref.windowId === 'world_art_board');
  assert.equal(row.spatial.x, 100, 'the v4 spatial patch landed');
  assert.equal(row.spatial.y, 200);
  assert.equal(row.spatial.width, 420);
  assert.equal(row.spatial.zIndex, 7);
  const v3row = workspaceV3.read().windows.find((w) => w.windowId === 'world_art_board');
  assert.equal(v3row.x, 100, 'the v3 upsert still landed (the caller-facing store)');
});

test('A2 invariant: v3-only types (shot, comic_page) map to generic_panel in the v4 store — legacy callers never hard-fail on the set difference', async () => {
  const { status } = await postObject({ id: 'panel_shot_thing', type: 'shot', x: 0, y: 0, width: 100, height: 80 });
  assert.equal(status, 200, 'v3-valid type accepted end-to-end');
  const row = workspaceV4.read().windows.find((w) => w.ref.windowId === 'panel_shot_thing');
  assert.ok(row, 'created');
  assert.equal(row.type, 'generic_panel', 'the v3-only type maps to generic_panel in v4 (set difference: v3 has shot/comic_page; v4 does not)');
  const v3row = workspaceV3.read().windows.find((w) => w.windowId === 'panel_shot_thing');
  assert.equal(v3row.type, 'shot', 'the v3 store keeps its native type — the stores agree on identity, not on type vocabulary');
});
