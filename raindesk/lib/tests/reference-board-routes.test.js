'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-reference-routes-'));
process.env.RAINDESK_DATA_DIR = scratch;
const { createServer } = require('../../server.js');

async function withServer(t, fn) {
  const server = createServer();
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    for (const socket of sockets) socket.destroy();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

test('reference media round-trips through SheetDocument REST revisions and bounded summaries', async (t) => {
  await withServer(t, async (base) => {
    let response = await fetch(`${base}/api/sheet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sheetId: 'route_refs', title: 'Rooftop references', kind: 'references' }),
    });
    assert.equal(response.status, 201);
    const created = (await response.json()).revision;

    const sha = 'b'.repeat(64);
    response = await fetch(`${base}/api/sheet/route_refs`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        baseRevisionId: created.revisionId,
        reason: 'add arranged reference',
        document: {
          ...created.document,
          media: [{ id: 'ref_route', kind: 'image', sha, x: 50, y: 60, width: 180, height: 120, rotation: 5, opacity: 0.9, zIndex: 1, caption: 'roofline' }],
        },
      }),
    });
    assert.equal(response.status, 200);
    const saved = (await response.json()).revision;
    assert.equal(saved.document.media.length, 1);
    assert.equal(saved.document.media[0].sha, sha);
    assert.equal(saved.document.media[0].rotation, 5);

    response = await fetch(`${base}/api/sheets`);
    const listed = await response.json();
    const summary = listed.sheets.find((sheet) => sheet.sheetId === 'route_refs');
    assert.equal(summary.mediaCount, 1);
    assert.equal(Object.hasOwn(summary, 'media'), false, 'list summary never expands raw media records');

    response = await fetch(`${base}/api/sheet/route_refs/revisions`);
    const history = await response.json();
    assert.equal(history.revisions.length, 2);
    assert.equal(history.currentRevisionId, saved.revisionId);

    response = await fetch(`${base}/api/sheet/route_refs/revision/${created.revisionId}/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRevisionId: saved.revisionId, reason: 'restore empty reference board' }),
    });
    assert.equal(response.status, 200);
    const restored = (await response.json()).revision;
    assert.equal(restored.document.media.length, 0);
    assert.equal(restored.restoredFromRevisionId, created.revisionId);
  });
});
