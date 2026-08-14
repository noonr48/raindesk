'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const comfy = require('../../lib/comfy');

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-png-bytes'),
]);

test('patchWorkflow substitutes every placeholder and types SEED as int', () => {
  const template = comfy.loadTemplate();
  const patched = comfy.patchWorkflow(template, {
    POSITIVE: 'a lantern in the rain, anna, blue hair',
    NEGATIVE: 'blurry, extra arms',
    IMAGE: 'input/region_1.png',
    MASK: 'input/mask_1.png',
    SEED: '123456789',
    PREFIX: 'raindesk/S01/123',
  });

  // template itself untouched (deep-clone)
  assert.equal(comfy.loadTemplate()['7'].inputs.seed, '{{SEED}}');
  assert.equal(comfy.loadTemplate()['2'].inputs.text, '{{POSITIVE}}');

  assert.equal(patched['2'].inputs.text, 'a lantern in the rain, anna, blue hair');
  assert.equal(patched['3'].inputs.text, 'blurry, extra arms');
  assert.equal(patched['4'].inputs.image, 'input/region_1.png');
  assert.equal(patched['5'].inputs.image, 'input/mask_1.png');
  assert.equal(patched['9'].inputs.filename_prefix, 'raindesk/S01/123');
  // SEED coerced to a plain integer within 0..2^32
  assert.equal(patched['7'].inputs.seed, 123456789);
  assert.ok(Number.isInteger(patched['7'].inputs.seed));
});

test('normalizeSeed validates and coerces', () => {
  assert.equal(comfy.normalizeSeed('42'), 42);
  assert.equal(comfy.normalizeSeed(7), 7);
  assert.equal(comfy.normalizeSeed(0), 0);
  assert.equal(comfy.normalizeSeed('4294967295'), 4294967295);
  const r = comfy.normalizeSeed(undefined);
  assert.ok(Number.isInteger(r) && r >= 0 && r <= comfy.SEED_MAX);
  assert.throws(() => comfy.normalizeSeed(-1));
  assert.throws(() => comfy.normalizeSeed('4294967296'));
  assert.throws(() => comfy.normalizeSeed(1.5));
  assert.throws(() => comfy.normalizeSeed('abc'));
});

/**
 * Mock ComfyUI over the fetch seam. Records requests; serves
 * /upload/image, /prompt, /history/{id}, /view deterministically.
 */
function mockComfy() {
  const state = {
    uploads: [],
    prompts: [],
    historyPolls: 0,
    finalStatus: 'success',
    outputs: [{ filename: 'raindesk_out_00001_.png', subfolder: 'raindesk', type: 'output' }],
  };
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/upload/image')) {
      const body = init.body;
      assert.ok(Buffer.isBuffer(body));
      assert.match(init.headers['Content-Type'], /^multipart\/form-data; boundary=/);
      // multipart carries field name "image" and the raw PNG magic bytes
      const text = body.toString('latin1');
      assert.ok(text.includes('name="image"'));
      assert.ok(body.subarray(0, 8).equals(PNG.subarray(0, 8)) === false); // boundary first
      assert.ok(body.includes(PNG.subarray(0, 8))); // magic inside the payload
      state.uploads.push(body);
      return { ok: true, json: async () => ({ name: `upd_${state.uploads.length}.png`, subfolder: 'raindesk' }) };
    }
    if (u.endsWith('/prompt')) {
      const parsed = JSON.parse(init.body);
      state.prompts.push(parsed);
      return { ok: true, json: async () => ({ prompt_id: 'pid-1', number: state.prompts.length }) };
    }
    if (u.includes('/history/')) {
      state.historyPolls += 1;
      if (state.historyPolls < 3) return { ok: true, json: async () => ({}) };
      return {
        ok: true,
        json: async () => ({
          'pid-1': {
            status: { status_str: state.finalStatus, messages: [] },
            outputs: { '9': { images: state.outputs } },
          },
        }),
      };
    }
    if (u.includes('/view')) {
      // PNG may be a pooled-Buffer view; slice the exact byte range, not buffer.slice(0)
      const ab = PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.byteLength);
      return { ok: true, arrayBuffer: async () => ab };
    }
    throw new Error(`mockComfy: unexpected URL ${u}`);
  };
  return { fetchImpl, state };
}

test('runInpaint: upload -> patch -> prompt -> poll -> view URL, end to end over mock http', async () => {
  const { fetchImpl, state } = mockComfy();
  const result = await comfy.runInpaint({
    shotId: 'S01',
    prompt: 'rain-lantern mood',
    negative: 'gore',
    seed: '99',
    imageBuffer: PNG,
    maskBuffer: PNG,
    opts: { fetchImpl, pollIntervalMs: 1, timeoutMs: 5000 },
  });

  // two uploads happened (region + mask), both multipart
  assert.equal(state.uploads.length, 2);
  // one prompt submitted with client_id raindesk and patched placeholders
  assert.equal(state.prompts.length, 1);
  const wf = state.prompts[0].prompt;
  assert.equal(state.prompts[0].client_id, 'raindesk');
  assert.equal(wf['2'].inputs.text, 'rain-lantern mood');
  assert.equal(wf['3'].inputs.text, 'gore');
  assert.equal(wf['4'].inputs.image, 'raindesk/upd_1.png');
  assert.equal(wf['5'].inputs.image, 'raindesk/upd_2.png');
  assert.equal(wf['7'].inputs.seed, 99);
  assert.match(wf['9'].inputs.filename_prefix, /^raindesk\/S01\//);
  // polling waited for completion
  assert.ok(state.historyPolls >= 3);
  // result carries the output image URL on the /view endpoint
  assert.equal(result.promptId, 'pid-1');
  assert.equal(result.seed, 99);
  assert.match(result.imageUrl, /^http:\/\/127\.0\.0\.1:8188\/view\?/);
  assert.match(result.imageUrl, /filename=raindesk_out_00001_\.png/);
  assert.match(result.imageUrl, /subfolder=raindesk/);
  assert.match(result.imageUrl, /type=output/);

  // bytes mirror works too
  const bytes = await comfy.fetchImageBytes(state.outputs[0], { fetchImpl });
  assert.ok(bytes.equals(PNG));
});

test('runInpaint rejects non-PNG buffers before touching the network', async () => {
  const { fetchImpl, state } = mockComfy();
  await assert.rejects(
    comfy.runInpaint({
      shotId: 'S01', prompt: 'x',
      imageBuffer: Buffer.from('not a png'),
      maskBuffer: PNG,
      opts: { fetchImpl },
    }),
    (e) => e.status === 400,
  );
  assert.equal(state.uploads.length, 0);
  assert.equal(state.prompts.length, 0);
});

test('runInpaint surfaces ComfyUI error status as HttpError', async () => {
  const { fetchImpl, state } = mockComfy();
  state.finalStatus = 'error';
  await assert.rejects(
    comfy.runInpaint({
      shotId: 'S01', prompt: 'x', imageBuffer: PNG, maskBuffer: PNG,
      opts: { fetchImpl, pollIntervalMs: 1, timeoutMs: 5000 },
    }),
    (e) => e.status === 502,
  );
});
