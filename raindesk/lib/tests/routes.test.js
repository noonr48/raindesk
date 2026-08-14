'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Scratch data dir BEFORE requiring modules that snapshot env at load.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'raindesk-routes-'));
process.env.RAINDESK_DATA_DIR = scratch;

const { createServer } = require('../../server.js');
const { GenQueue } = require('../../lib/queue');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('layer-bytes'),
]);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(t, deps, fn) {
  const server = createServer(deps);
  // undici keep-alive sockets would keep server.close() pending forever
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  t.after(() => new Promise((r) => {
    server.close(() => r());
    for (const s of sockets) s.destroy();
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await fn(`http://127.0.0.1:${port}`);
}

function fakeComfy(delayMs = 20) {
  return {
    async runInpaint(params) {
      await delay(delayMs);
      assert.ok(Buffer.isBuffer(params.imageBuffer));
      assert.ok(Buffer.isBuffer(params.maskBuffer));
      return {
        promptId: 'pid-test',
        seed: 1,
        images: [{ filename: 'out.png', subfolder: '', type: 'output' }],
        imageUrl: 'http://127.0.0.1:8188/view?filename=out.png&subfolder=&type=output',
      };
    },
  };
}

const agentEcho = { chat: async (m) => `echo: ${m}` };

test('negative routes: 404s and bad uploads', async (t) => {
  await withServer(t, { comfyImpl: fakeComfy(), agentImpl: agentEcho }, async (base) => {
    // unknown API route
    let res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    assert.match((await res.json()).error, /not found/);

    // unknown static file
    res = await fetch(`${base}/missing.css`);
    assert.equal(res.status, 404);

    // unknown job id
    res = await fetch(`${base}/api/gen/999`);
    assert.equal(res.status, 404);

    // static path traversal
    res = await fetch(`${base}/..%2fserver.js`);
    assert.equal(res.status, 404);
    res = await fetch(`${base}/%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    assert.equal(res.status, 404);

    // shot image traversal attempt
    res = await fetch(`${base}/api/shot/S01/image/..%2f..%2fboard.json`);
    assert.equal(res.status, 404);
    res = await fetch(`${base}/api/shot/S01/image/..%2fpwn.png`);
    assert.equal(res.status, 404);

    // shot id with slash (inject attempt) fails id validation
    const fd1 = new FormData();
    fd1.append('image', new Blob([PNG]), 'layer.png');
    res = await fetch(`${base}/api/shot/IN%2FJECT/layer`, { method: 'POST', body: fd1 });
    assert.equal(res.status, 400);

    // multipart upload that is not a PNG
    const fd2 = new FormData();
    fd2.append('image', new Blob([Buffer.from('definitely not a png')]), 'evil.png');
    res = await fetch(`${base}/api/shot/S01/layer`, { method: 'POST', body: fd2 });
    assert.equal(res.status, 400);

    // layer upload with wrong content type
    res = await fetch(`${base}/api/shot/S01/layer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(res.status, 400);

    // gen without PNG magic in mask
    res = await fetch(`${base}/api/gen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01',
        prompt: 'x',
        regionPng: PNG.toString('base64'),
        maskPng: Buffer.from('nope').toString('base64'),
      }),
    });
    assert.equal(res.status, 400);

    // gen missing prompt
    res = await fetch(`${base}/api/gen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01',
        regionPng: PNG.toString('base64'),
        maskPng: PNG.toString('base64'),
      }),
    });
    assert.equal(res.status, 400);

    // gen bad seed
    res = await fetch(`${base}/api/gen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01',
        prompt: 'x',
        seed: 'not-a-seed',
        regionPng: PNG.toString('base64'),
        maskPng: PNG.toString('base64'),
      }),
    });
    assert.equal(res.status, 400);

    // bad JSON body
    res = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops',
    });
    assert.equal(res.status, 400);

    // move to unknown lane / unknown shot
    res = await fetch(`${base}/api/board/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'S01', lane: 'planned' }),
    });
    assert.equal(res.status, 400);
    res = await fetch(`${base}/api/board/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'S99', lane: 'set' }),
    });
    assert.equal(res.status, 404);
  });
});

test('positive flow: board, move, layer upload+serve, gen job, chat', async (t) => {
  await withServer(t, { comfyImpl: fakeComfy(30), agentImpl: agentEcho }, async (base) => {
    // board seeded
    let res = await fetch(`${base}/api/board`);
    let board = await res.json();
    assert.equal(res.status, 200);
    assert.equal(board.shots.length, 7);

    // move round-trip (accepts shotId or shot key)
    res = await fetch(`${base}/api/board/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shotId: 'S04', lane: 'in_dev' }),
    });
    assert.equal(res.status, 200);
    board = (await res.json()).board;
    assert.equal(board.shots.find((s) => s.id === 'S04').lane, 'in_dev');
    res = await fetch(`${base}/api/board/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shot: 'S05', lane: 'set' }),
    });
    assert.equal(res.status, 200);
    board = await (await fetch(`${base}/api/board`)).json();
    assert.equal(board.shots.find((s) => s.id === 'S05').lane, 'set');

    // layer upload + serve + bytes match
    const fd = new FormData();
    fd.append('image', new Blob([PNG]), 'layer.png');
    res = await fetch(`${base}/api/shot/S01/layer`, { method: 'POST', body: fd });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.match(saved.url, /^\/api\/shot\/S01\/image\/\d+(-\d+)?\.png$/);
    res = await fetch(base + saved.url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.ok(bytes.equals(PNG));

    // shot meta endpoint lists layers + activeLayer
    res = await fetch(`${base}/api/shot/S01`);
    assert.equal(res.status, 200);
    const meta = await res.json();
    assert.equal(meta.id, 'S01');
    assert.ok(meta.layers.some((l) => l.file === saved.file));
    assert.equal(meta.activeLayer, saved.file);
    res = await fetch(`${base}/api/shot/BAD%2FID`);
    assert.equal(res.status, 400);

    // gen job: submit then poll to done with imageUrl
    res = await fetch(`${base}/api/gen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01', layerId: saved.file, prompt: 'rain lantern',
        regionPng: PNG.toString('base64'), maskPng: PNG.toString('base64'),
      }),
    });
    assert.equal(res.status, 200);
    const { jobId } = await res.json();
    let view = null;
    for (let i = 0; i < 200 && (!view || view.status === 'pending'); i++) {
      // eslint-disable-next-line no-await-in-loop
      const r = await fetch(`${base}/api/gen/${jobId}`);
      view = await r.json();
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
    assert.equal(view.status, 'done');
    assert.match(view.imageUrl, /\/view\?filename=out\.png/);

    // chat
    res = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'hi friend' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, 'echo: hi friend');
  });
});

test('gen errors surface as status error with a message', async (t) => {
  const brokenComfy = {
    async runInpaint() { throw new Error('comfy exploded'); },
  };
  await withServer(t, { comfyImpl: brokenComfy, agentImpl: agentEcho }, async (base) => {
    const res = await fetch(`${base}/api/gen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01', prompt: 'x',
        regionPng: PNG.toString('base64'), maskPng: PNG.toString('base64'),
      }),
    });
    const { jobId } = await res.json();
    let view = { status: 'pending' };
    for (let i = 0; i < 200 && view.status === 'pending'; i++) {
      // eslint-disable-next-line no-await-in-loop
      view = await (await fetch(`${base}/api/gen/${jobId}`)).json();
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
    assert.equal(view.status, 'error');
    assert.match(view.error, /comfy exploded/);
  });
});
