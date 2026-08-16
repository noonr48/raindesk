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

/** Mirror-capable fake: like fakeComfy but serves real bytes via fetchImageBytes. */
function fakeComfyMirroring(delayMs = 20) {
  const comfy = fakeComfy(delayMs);
  comfy.fetchImageBytes = async () => PNG;
  return comfy;
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

test('mirrored gen: same-origin /api/assets imageUrl, comfyUrl preserved, bytes served 200', async (t) => {
  await withServer(t, { comfyImpl: fakeComfyMirroring(), agentImpl: agentEcho }, async (base) => {
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
      view = await (await fetch(`${base}/api/gen/${jobId}`)).json();
      await delay(5);
    }
    assert.equal(view.status, 'done');
    assert.match(view.imageUrl, /^\/api\/assets\/S01\//, 'phone-safe same-origin URL');
    assert.equal(view.comfyUrl, 'http://127.0.0.1:8188/view?filename=out.png&subfolder=&type=output', 'comfy origin preserved');
    // the mirrored bytes actually serve from the app itself
    const img = await fetch(`${base}${view.imageUrl}`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await img.arrayBuffer());
    assert.ok(body.equals(PNG), 'served bytes round-trip');
  });
});

test('chat concurrency: 429 when 3 in flight; counter balances after validation throws', async (t) => {
  // part 1: invalid body when idle → 400; the counter must stay balanced
  // (increment-before-readJson + finally) so the next chat still succeeds.
  await withServer(t, { agentImpl: agentEcho }, async (base) => {
    const send = (m) => fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: m }),
    });
    const bad = await send('');
    assert.equal(bad.status, 400, 'empty message rejected');
    const ok = await send('hi');
    assert.equal(ok.status, 200, 'counter balanced after 400 path');
    assert.equal((await ok.json()).reply, 'echo: hi');
  });

  // part 2: three concurrent chats hold all slots; the fourth gets 429;
  // after release the counter drains and a fresh chat succeeds.
  let release;
  const gate = new Promise((r) => { release = r; });
  let started = 0;
  const slowAgent = { async chat() { started += 1; await gate; return 'ok'; } };
  await withServer(t, { agentImpl: slowAgent }, async (base) => {
    const send = (m) => fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: m }),
    });
    const inFlight = [send('a'), send('b'), send('c')];
    // deterministic gate: wait until all three have actually started (holding
    // slots) instead of a fixed sleep — no timing flake on a loaded box.
    const deadline = Date.now() + 5000;
    while (started < 3 && Date.now() < deadline) await delay(5);
    assert.equal(started, 3, 'three chats started and hold the slots');
    const r4 = await send('d');
    assert.equal(r4.status, 429, 'fourth concurrent chat refused');
    assert.match((await r4.json()).error, /one moment/);
    release();
    for (const p of inFlight) assert.equal((await p).status, 200);
    const r5 = await send('e');
    assert.equal(r5.status, 200, 'slots drain after settle');
    assert.equal(started, 4, 'exactly 4 agent invocations (three + one after)');
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

test('direction v2 routes persist scene -> shot -> beat -> annotation', async (t) => {
  await withServer(t, { comfyImpl: fakeComfy(), agentImpl: agentEcho }, async (base) => {
    let res = await fetch(`${base}/api/direction`);
    assert.equal(res.status, 200);
    let graph = await res.json();
    assert.equal(graph.schemaVersion, 1);

    res = await fetch(`${base}/api/direction/scene`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'route_scene', title: 'Rooftop fight', description: 'Two people are fighting.' }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/direction/shot`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'route_shot', sceneId: 'route_scene', title: 'Closing distance' }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/direction/beat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'route_beat', shotId: 'route_shot',
        rawDirection: 'clicks his tongue while shaking his fist before the fight',
        movement: { action: 'tongue click + fist shake', timing: 'before attack' },
      }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/direction/annotation`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'route_cam', scopeType: 'shot', scopeId: 'route_shot', kind: 'camera_path',
        rawText: 'spiral from low behind up to the face',
        interpretation: { path: 'rising orbit', end: 'face close-up' },
      }),
    });
    assert.equal(res.status, 201);

    res = await fetch(`${base}/api/direction/shot-anchor`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'route_shot', slot: 'start',
        anchor: { kind: 'direction_path_endpoint', point: { x: 12, y: 90 }, framing: 'low rear' },
      }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/api/direction/shot-anchor`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'route_shot', slot: 'end',
        anchor: { kind: 'direction_path_endpoint', point: { x: 70, y: 15 }, framing: 'face close-up' },
      }),
    });
    assert.equal(res.status, 200);

    const specRes = await fetch(`${base}/api/direction/shot/route_shot/spec`);
    assert.equal(specRes.status, 200);
    const spec = await specRes.json();
    assert.equal(spec.shot.startFrame.framing, 'low rear');
    assert.equal(spec.shot.endFrame.framing, 'face close-up');
    assert.equal(spec.beats[0].id, 'route_beat');

    graph = await (await fetch(`${base}/api/direction`)).json();
    assert.equal(graph.scenes.some((x) => x.id === 'route_scene'), true);
    assert.equal(graph.shots.some((x) => x.id === 'route_shot'), true);
    assert.equal(graph.beats.find((x) => x.id === 'route_beat').movement.timing, 'before attack');
    assert.match(graph.annotations.find((x) => x.id === 'route_cam').rawText, /spiral/);
  });
});

test('partner route supports empty anti-freeze kickstart and structured turns', async (t) => {
  const calls = [];
  const partnerImpl = {
    async turn(input) {
      calls.push(input);
      return {
        message: input.mode === 'kickstart' ? "Let's start with one moment you can see." : 'I read the move.',
        interpretation: { kind: input.mode === 'kickstart' ? 'setup' : 'movement' },
        nextMoves: [{ label: 'Try 3 rough openings', prompt: 'rough three openings', kind: 'rough_options' }],
        workflow: [], boardActions: [], question: null, kickstart: input.mode === 'kickstart',
        partnerMode: 'suggest', intentId: null,
      };
    },
  };
  await withServer(t, { comfyImpl: fakeComfy(), agentImpl: agentEcho, partnerImpl }, async (base) => {
    let res = await fetch(`${base}/api/partner/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'kickstart', context: { surface: 'blank_board' } }),
    });
    assert.equal(res.status, 200);
    let body = await res.json();
    assert.equal(body.kickstart, true);
    assert.equal(body.nextMoves[0].label, 'Try 3 rough openings');

    res = await fetch(`${base}/api/partner/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'push in while she speaks', context: { surface: 'shot_canvas' } }),
    });
    assert.equal(res.status, 200);
    body = await res.json();
    assert.equal(body.interpretation.kind, 'movement');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].message, 'push in while she speaks');
  });
});
