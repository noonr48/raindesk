'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-character-routes-'));
process.env.RAINDESK_DATA_DIR = scratch;
const { createServer } = require('../../server.js');

async function withServer(t, partnerImpl, fn) {
  const server = createServer({ partnerImpl });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(() => new Promise((resolve) => { server.close(resolve); for (const socket of sockets) socket.destroy(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await fn(`http://127.0.0.1:${server.address().port}`);
}

test('character anchors bind to a shot and are injected into Partner context by the server', async (t) => {
  let captured = null;
  await withServer(t, { async turn(input) { captured = input; return { message: 'ok', nextMoves: [], actions: [] }; } }, async (base) => {
    const sha = 'd'.repeat(64);
    let response = await fetch(`${base}/api/character`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'anna', name: 'Anna', aliases: ['Anna'], canonicalSheetId: 'sheet_character_primary', locked: true,
        identityRules: ['teenager', 'two arms'],
        anchors: [{ id: 'front', sha, sheetId: 'sheet_character_primary', mediaId: 'ref_front', view: 'front', label: 'front model' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).character.locked, true);

    response = await fetch(`${base}/api/character/shot-binding`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'S01', characterIds: ['anna'] }),
    });
    assert.equal(response.status, 200);
    const binding = await response.json();
    assert.deepEqual(binding.characterIds, ['anna']);
    assert.equal(binding.characters[0].anchors[0].sha, sha);

    response = await fetch(`${base}/api/partner/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'keep her face consistent', context: { legacyShotId: 'S01', surface: 'storyboard_canvas' } }),
    });
    assert.equal(response.status, 200);
    assert.ok(captured && captured.context && captured.context.characterAnchors);
    assert.equal(captured.context.characterAnchors.characters[0].id, 'anna');
    assert.equal(captured.context.characterAnchors.characters[0].anchors[0].sha, sha);

    response = await fetch(`${base}/api/characters`);
    const listed = await response.json();
    assert.deepEqual(listed.characters.map((item) => item.id), ['anna']);
  });
});
