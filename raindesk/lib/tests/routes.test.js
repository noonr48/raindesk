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
    assert.ok(meta.layers.some((l) => l.shotId === 'S01'), 'saved layer listed');
    assert.equal(meta.activeLayer, saved.file);

    // gen => immediate jobId
    res = await fetch(`${base}/api/gen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01', prompt: 'rain window',
        regionPng: PNG.toString('base64'), maskPng: PNG.toString('base64'),
      }),
    });
    assert.equal(res.status, 200);
    const gen = await res.json();
    assert.match(gen.jobId, /^\d+$/);

    // poll until done
    let view = { status: 'pending' };
    for (let i = 0; i < 200 && view.status === 'pending'; i++) {
      // eslint-disable-next-line no-await-in-loop
      view = await (await fetch(`${base}/api/gen/${gen.jobId}`)).json();
      // eslint-disable-next-line no-await-in-loop
      await delay(5);
    }
    assert.equal(view.status, 'done');
    assert.match(view.imageUrl, /127.0.0.1:8188/view/);

    // chat
    res = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'lantern?' }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reply, 'echo: lantern?');
  });
});

test('mirrored gen: same-origin /api/assets imageUrl, comfyUrl preserved, bytes served 200', async (t) => {
  await withServer(t, { comfyImpl: fakeComfyMirroring(5), agentImpl: agentEcho }, async (base) => {
    let res = await fetch(`${base}/api/gen`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shotId: 'S01', prompt: 'mirror me',
        regionPng: PNG.toString('base64'), maskPng: PNG.toString('base64'),
      }),
    });
    assert.equal(res.status, 200);
    const { jobId } = await res.json();
    let view = { status: 'pending' };
    for (let i = 0; i < 200 && view.status === 'pending'; i++) {
      // eslint-disable-next-line no-await-in-loop
      view = await (await fetch(`${base}/api/gen/${jobId}`))œÛÛŠ
NÂˆËÈ\Û[Y\ØX›K[™^[[™H›ËX]ØZ]Z[‹[ÛÜˆ]ØZ][^JJNÂˆBˆ\ÜÙ\™\]X[
šY]ËœÝ]\Ë	ÙÛ™IÊNÂˆ\ÜÙ\›X]Ú
šY]Ëš[XYÙU\›×—Ø\WØ\ÜÙ]×ÔÌWËË	ÜÛ™K\ØY™HØ[YK[ÜšYÚ[ˆT“	ÊNÂˆ\ÜÙ\™\]X[
šY]Ë˜ÛÛYžU\›	Ú‹ËÌLËŒŒŒNŽNÝšY]ÏÙš[[˜[YO[Ý]œ™ÉœÝX™›Û\I\O[Ý]]	Ë	ØÛÛYžHÜšYÚ[ˆ™\Ù\™Y	ÊNÂˆËÈHZ\œ›Ü™Yž]\ÈXÝX[HÙ\™Hœ›ÛHH\]Ù[‚ˆÛÛœÝ[YÈH]ØZ]™]Ú
	Ø˜\Ù_IÝšY]Ëš[XYÙU\›X
NÂˆ\ÜÙ\™\]X[
[YËœÝ]\ËŒ
NÂˆ\ÜÙ\™\]X[
[YËšXY\œË™Ù]
	ØÛÛ[]\IÊK	Ú[XYÙKÜ™ÉÊNÂˆÛÛœÝ›ÙHHY™™\‹™œ›ÛJ]ØZ][YË˜\œ˜^PY™™\Š
JNÂˆ\ÜÙ\›ÚÊ›ÙK™\]X[Ê‘ÊK	ÜÙ\™Yž]\È›Ý[™]š\	ÊNÂˆJNÂŸJNÂ‚\Ý
	ØÚ]ÛÛ˜Ý\œ™[˜ÞNˆŽHÚ[ˆÈ[ˆ›YÚÈÛÝ[\ˆ˜[[˜Ù\ÈY\ˆ˜[Y][Ûˆ›ÝÜÉË\Þ[˜È

HOˆÂˆËÈ\Nˆ[˜[Y›ÙHÚ[ˆYH8¡¤ˆÈHÛÝ[\ˆ]\ÝÝ^H˜[[˜ÙYˆËÈ
[˜Ü™[Y[X™Y›Ü™K\™XYœÛÛˆ
Èš[˜[JHÛÈH™^Ú]Ý[ÝXØÙYYË‚ˆ]ØZ]Ú]Ù\™\ŠÈYÙ[[\ˆYÙ[XÚÈK\Þ[˜È
˜\ÙJHOˆÂˆÛÛœÝÙ[™H
JHOˆ™]Ú
	Ø˜\Ù_KØ\KØÚ]ÂˆY]Ùˆ	ÔÔÕ	ËXY\œÎˆÈ	ÐÛÛ[U\IÎˆ	Ø\XØ][Û‹ÚœÛÛ‰ÈKˆ›ÙNˆ”ÓÓ‹œÝš[™ÚYžJÈY\ÜØYÙNˆHJKˆJNÂˆÛÛœÝ˜YH]ØZ]Ù[™
	ÉÊNÂˆ\ÜÙ\™\]X[
˜YœÝ]\Ë	Ù[\HY\ÜØYÙH™Z™XÝY	ÊNÂˆÛÛœÝÚÈH]ØZ]Ù[™
	ÚIÊNÂˆ\ÜÙ\™\]X[
ÚËœÝ]\ËŒ	ØÛÝ[\ˆ˜[[˜ÙYY\ˆ]	ÊNÂˆ\ÜÙ\™\]X[

]ØZ]ÚËšœÛÛŠ
JKœ™\K	ÙXÚÎˆIÊNÂˆJNÂ‚ˆËÈ\Žˆ™YHÛÛ˜Ý\œ™[Ú]ÈÛ[ÛÝÎÈH›Ý\Ù]ÈŽK‚ˆËÈY\ˆ™[X\ÙHHÛÝ[\ˆ˜Z[œÈ[™Hœ™\ÚÚ]ÝXØÙYYË‚ˆ]™[X\ÙNÂˆÛÛœÝØ]HH™]È›ÛZ\ÙJ
ŠHOˆÈ™[X\ÙHHŽÈJNÂˆ]Ý\YHÂˆÛÛœÝÛÝÐYÙ[HÈ\Þ[˜ÈÚ]

HÈÝ\Y
ÏHNÈ]ØZ]Ø]NÈ™]\›ˆ	ÛÚÉÎÈHNÂˆ]ØZ]Ú]Ù\™\ŠÈYÙ[[\ˆÛÝÐYÙ[K\Þ[˜È
˜\ÙJHOˆÂˆÛÛœÝÙ[™H
JHOˆ™]Ú
	Ø˜\Ù_KØ\KØÚ]ÂˆY]Ùˆ	ÔÔÕ	ËXY\œÎˆÈ	ÐÛÛ[U\IÎˆ	Ø\XØ][Û‹ÚœÛÛ‰ÈKˆ›ÙNˆ”ÓÓ‹œÝš[™ÚYžJÈY\ÜØYÙNˆHJKˆJNÂˆÛÛœÝ[‘›YÚHÜÙ[™
	ØIÊKÙ[™
	Ø‰ÊKÙ[™
	ØÉÊWNÂˆËÈ]\›Z[š\ÝXÈØ]NˆØZ][[[™YH]™HXÝX[HÝ\Y
Û[™ÂˆËÈÛÝÊH[œÝXYÙˆHš^YÛY\8 %›È[Z[™È›ZÙHÛˆHØYY›Þ‚ˆÛÛœÝXY[™HH]K››ÝÊ
H
ÈLÂˆÚ[H
Ý\YÈ	‰ˆ]K››ÝÊ
HXY[™JH]ØZ][^JJNÂˆ\ÜÙ\™\]X[
Ý\YË	Ý™YHÚ]ÈÝ\Y[™ÛHÛÝÉÊNÂˆÛÛœÝH]ØZ]Ù[™
	Ù	ÊNÂˆ\ÜÙ\™\]X[
œÝ]\ËŽK	Ù›Ý\ÛÛ˜Ý\œ™[Ú]™Y\ÙY	ÊNÂˆ\ÜÙ\›X]Ú

]ØZ]šœÛÛŠ
JK™\œ›Ü‹ÛÛ™H[ÛY[ÊNÂˆ™[X\ÙJ
NÂˆ›Üˆ
ÛÛœÝÙˆ[‘›YÚ
H\ÜÙ\™\]X[

]ØZ]
KœÝ]\ËŒ
NÂˆÛÛœÝHH]ØZ]Ù[™
	ÙIÊNÂˆ\ÜÙ\™\]X[
KœÝ]\ËŒ	ÜÛÝÈ˜Z[ˆY\ˆÙ]IÊNÂˆ\ÜÙ\™\]X[
Ý\Y	Ù^XÝHYÙ[[›ØØ][ÛœÈ
™YH
ÈÛ™HY\ŠIÊNÂˆJNÂŸJNÂ‚\Ý
	ÙÙ[ˆ\œ›ÜœÈÝ\™˜XÙH\ÈÝ]\È\œ›ÜˆÚ]HY\ÜØYÙIË\Þ[˜È

HOˆÂˆÛÛœÝœ›ÚÙ[ÛÛYžHHÂˆ\Þ[˜È[’[œZ[

HÈ›ÝÈ™]È\œ›ÜŠ	ØÛÛYžH^ÙY	ÊNÈKˆNÂˆ]ØZ]Ú]Ù\™\ŠÈÛÛYžR[\ˆœ›ÚÙ[ÛÛYžKYÙ[[\ˆYÙ[XÚÈK\Þ[˜È
˜\ÙJHOˆÂˆÛÛœÝ™\ÈH]ØZ]™]Ú
	Ø˜\Ù_KØ\KÙÙ[˜ÂˆY]Ùˆ	ÔÔÕ	ËXY\œÎˆÈ	ÐÛÛ[U\IÎˆ	Ø\XØ][Û‹ÚœÛÛ‰ÈKˆ›ÙNˆ”ÓÓ‹œÝš[™ÚYžJÂˆÚÝYˆ	ÔÌIË›Û\ˆ	Þ	Ëˆ™YÚ[Û”™Îˆ‘ËÔÝš[™Ê	Ø˜\ÙM	ÊKX\ÚÔ™Îˆ‘ËÔÝš[™Ê	Ø˜\ÙM	ÊKˆJKˆJNÂˆÛÛœÝÈ›Ø’YHH]ØZ]™\ËšœÛÛŠ
NÂˆ]šY]ÈHÈÝ]\Îˆ	Ü[™[™ÉÈNÂˆ›Üˆ
]HHÈHŒ	‰ˆšY]ËœÝ]\ÈOOH	Ü[™[™ÉÎÈJÊÊHÂˆËÈ\Û[Y\ØX›K[™^[[™H›ËX]ØZ]Z[‹[ÛÜˆšY]ÈH]ØZ]
]ØZ]™]Ú
	Ø˜\Ù_KØ\KÙÙ[‹ÉÚ›Ø’YX
JF§6öâ‚“°¢òòW6Æ–çBÖF—6&ÆRÖæW‡BÖÆ–æRæòÖv—BÖ–âÖÆö÷ ¢v—BFVÆ’ƒR“°¢Ð¢76W'BæWVÂ‡f–Wrç7FGW2ÂvW'&÷"r“°¢76W'BæÖF6‚‡f–WræW'&÷"Âö6öÖg’W‡ÆöFVBò“°¢Ò“°§Ò“° §FW7B‚vF—&V7F–öâc"&÷WFW2W'6—7B66VæRÓâ6†÷BÓâ&VBÓâææ÷FF–öârÂ7–æ2‡B’Óâ°¢v—Bv—F…6W'fW"‡BÂ²6öÖg”–×Ã¢f¶T6öÖg’‚’ÂvVçD–×Ã¢vVçDV6†òÒÂ7–æ2†&6R’Óâ°¢ÆWB&W2Òv—BfWF6‚†G¶&6WÒö’öF—&V7F–öæ“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“°¢ÆWBw&‚Òv—B&W2æ§6öâ‚“°¢76W'BæWVÂ†w&‚ç66†VÖfW'6–öâÂ“° ¢&W2Òv—BfWF6‚†G¶&6WÒö’öF—&V7F–öâ÷66VæVÂ°¢ÖWF†öC¢uõ5BrÂ†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²–C¢w&÷WFU÷66VæRrÂF—FÆS¢u&öögF÷f–v‡BrÂFW67&—F–öã¢uGvòV÷ÆR&Rf–v‡F–ærârÒ’À¢Ò“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“° ¢&W2Òv—BfWF6‚†G¶&6WÒö’öF—&V7F–öâ÷6†÷FÂ°¢ÖWF†öC¢uõ5BrÂ†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²–C¢w&÷WFU÷6†÷BrÂ66VæT–C¢w&÷WFU÷66VârÂF—FÆS¢t6Æ÷6–ærF—7Fæ6RrÒ’À¢Ò“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“° ¢&W2Òv—BfWF6‚†G¶&6WÒö’öF—&V7F–öâö&VFÂ°¢ÖWF†öC¢uõ5BrÂ†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢–C¢w&÷WFUö&VBrÂ6†÷D–C¢w&÷WFU÷6†÷BrÀ¢&tF—&V7F–öã¢v6Æ–6·2†—2FöæwVRv†–ÆR6†¶–ær†—2f—7B&Vf÷&RF†Rf–v‡BrÀ¢Ö÷fVÖVçC¢²7F–öã¢wFöæwVR6Æ–6²²f—7B6†¶RrÂF–Ö–æs¢v&Vf÷&RGF6²rÒÀ¢Ò’À¢Ò“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“° ¢&W2Òv—BfWF6‚†G¶&6WÒö’öF—&V7F–öâöææ÷FF–öæÂ°¢ÖWF†öC¢uõ5BrÂ†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡°¢–C¢w&÷WFUö6ÒrÂ66÷UG—S¢w6†÷BrÂ66÷T–C¢w&÷WFU÷6†÷BrÂ¶–æC¢v6ÖW&÷F‚rÀ¢&uFW‡C¢w7—&Âg&öÒÆ÷r&V†–æBWFòF†Rf6RrÀ¢–çFW'&WFF–öã¢²Fƒ¢w&—6–ær÷&&—BrÂVæC¢vf6R6Æ÷6R×WrÒÀ¢Ò’À¢Ò“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“° ¢w&‚Òv—B†v—BfWF6‚†G¶&6WÒö’öF—&V7F–öæ’’æ§6öâ‚“°¢76W'BæWVÂ†w&‚ç66VæW2ç6öÖR‚‡‚’Óâ‚æ–BÓÓÒw&÷WFU÷66VæRr’ÂG'VR“°¢76W'BæWVÂ†w&‚ç6†÷G2ç6öÖR‚‡‚’Óâ‚æ–BÓÓÒw&÷WFU÷6†÷Br’ÂG'VR“°¢76W'BæWVÂ†w&‚æ&VG2æf–æB‚‡‚’Óâ‚æ–BÓÓÒw&÷WFUö&VBr’æÖ÷fVÖVçBçF–Ö–ærÂv&Vf÷&RGF6²r“°¢76W'BæÖF6‚†w&‚æææ÷FF–öç2æf–æB‚‡‚’Óâ‚æ–BÓÓÒw&÷WFUö6Òr’ç&uFW‡BÂ÷7—&Âò“°¢Ò“°§Ò“° §FW7B‚w'FæW"&÷WFR7W÷'G2V×G’çF’Ög&VW¦R¶–6·7F'BæB7G'V7GW&VBGW&ç2rÂ7–æ2‡B’Óâ°¢6öç7B6ÆÇ2ÒµÓ°¢6öç7B'FæW$–×ÂÒ°¢7–æ2GW&â†–çWB’°¢6ÆÇ2çW6‚†–çWB“°¢&WGW&â°¢ÖW76vS¢–çWBæÖöFRÓÓÒv¶–6·7F'BròtÆWN(	—27F'Bv—F‚öæRÖöÖVçB–÷R6â6VRâr¢t’&VBF†RÖ÷fRârÀ¢–çFW'&WFF–öã¢²¶–æC¢–çWBæÖöFRÓÓÒv¶–6·7F'Bròw6WGWr¢vÖ÷fVÖVçBrÒÀ¢æW‡DÖ÷fW3¢·²Æ&VÃ¢uG'’2&÷Vv‚÷Væ–æw2rÂ&ö×C¢w&÷Vv‚F‡&VR÷Væ–æw2rÂ¶–æC¢w&÷Vv…ö÷F–öç2rÕÒÀ¢v÷&¶fÆ÷s¢µÒÂ&ö&D7F–öç3¢µÒÂVW7F–öã¢çVÆÂÂ¶–6·7F'C¢–çWBæÖöFRÓÓÒv¶–6·7F'BrÀ¢'FæW$ÖöFS¢w7VvvW7BrÂ–çFVçD–C¢çVÆÂÀ¢Ó°¢ÒÀ¢Ó°¢v—Bv—F…6W'fW"‡BÂ²6öÖg”–×Ã¢f¶T6öÖg’‚’ÂvVçD–×Ã¢vVçDV6†òÂ'FæW$–×ÂÒÂ7–æ2†&6R’Óâ°¢ÆWB&W2Òv—BfWF6‚†G¶&6WÒö’÷'FæW"÷GW&æÂ°¢ÖWF†öC¢uõ5BrÂ†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²ÖöFS¢v¶–6·7F'BrÂ6öçFW‡C¢²7W&f6S¢v&Ææµö&ö&BrÒÒ’À¢Ò“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“°¢ÆWB&öG’Òv—B&W2æ§6öâ‚“°¢76W'BæWVÂ†&öG’æ¶–6·7F'BÂG'VR“°¢76W'BæWVÂ†&öG’ææW‡DÖ÷fW5³ÒæÆ&VÂÂuG'’2&÷Vv‚÷Væ–æw2r“° ¢&W2Òv—BfWF6‚†G¶&6WÒö’÷'FæW"÷GW&æÂ°¢ÖWF†öC¢uõ5BrÂ†VFW'3¢²t6öçFVçBÕG—Rs¢vÆ–6F–öâö§6öârÒÀ¢&öG“¢¥4ôâç7G&–æv–g’‡²ÖW76vS¢wW6‚–âv†–ÆR6†R7V·2rÂ6öçFW‡C¢²7W&f6S¢w6†÷Eö6çf2rÒÒ’À¢Ò“°¢76W'BæWVÂ‡&W2ç7FGW2Â#“°¢&öG’Òv—B&W2æ§6öâ‚“°¢76W'BæWVÂ†&öG’æ–çFW'&WFF–öâæ¶–æBÂvÖ÷fVÖVçBr“°¢76W'BæWVÂ†6ÆÇ2æÆVæwF‚Â"“°¢76W'BæWVÂ†6ÆÇ5³ÒæÖW76vRÂwW6‚–âv†–ÆR6†R7V·2r“°¢Ò“°§Ò“° 