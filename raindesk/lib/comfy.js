'use strict';

/**
 * ComfyUI bridge (zero-dep, Node >= 18 global fetch).
 *
 * - Patches the SDXL inpaint template (lib/workflows/inpaint.json, live-verified,
 *   node structure untouched) by string substitution: {{POSITIVE}} {{NEGATIVE}}
 *   {{IMAGE}} {{MASK}} {{PREFIX}} are strings; {{SEED}} becomes an integer 0..2^32-1.
 * - Uploads region + mask PNGs via multipart POST /upload/image (field "image"),
 *   using the server-returned name (subfolder-prefixed when ComfyUI reports one).
 * - POST /prompt with { prompt, client_id: 'raindesk' }, polls GET /history/{id}
 *   until status_str is success/error, then reports the /view URL of the output.
 *
 * Mask polarity (ComfyUI LoadImageMask): white = repaint.
 */

const crypto = require('crypto');
const { HttpError } = require('./errors');
const { validatePngBuffer } = require('./validate');

const DEFAULT_BASE = 'http://127.0.0.1:8188';
const CLIENT_ID = 'raindesk';
const SEED_MAX = 4294967295; // 2^32 - 1
const DEFAULT_POLL_INTERVAL_MS = 750;
const DEFAULT_TIMEOUT_MS = 300000; // 5 min for one SDXL inpaint

const STRING_SLOTS = ['POSITIVE', 'NEGATIVE', 'IMAGE', 'MASK', 'PREFIX'];

function randomSeed() {
  return crypto.randomInt(SEED_MAX + 1);
}

/** Coerce/validate a seed: undefined -> fresh random; must be int 0..2^32-1. */
function normalizeSeed(value) {
  if (value === undefined || value === null || value === '') return randomSeed();
  const n = typeof value === 'number' ? value
    : (typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isInteger(n) || n < 0 || n > SEED_MAX) {
    throw new HttpError(400, `seed must be an integer between 0 and ${SEED_MAX}`);
  }
  return n;
}

function safeName(name) {
  return String(name).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Deep-clone the workflow template with placeholders substituted.
 * {{SEED}} is only replaced where it is the ENTIRE string value, so the JSON
 * type becomes a number (KSampler wants an int seed). The other slots are
 * plain substring replacements inside string values.
 */
function patchWorkflow(template, values) {
  const seed = normalizeSeed(values.SEED);
  const subs = {};
  for (const slot of STRING_SLOTS) subs[slot] = String(values[slot] ?? '');

  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [key, val] of Object.entries(node)) out[key] = walk(val);
      return out;
    }
    if (typeof node === 'string') {
      if (node === '{{SEED}}') return seed;
      let s = node;
      for (const [name, val] of Object.entries(subs)) {
        const token = `{{${name}}}`;
        if (s.includes(token)) s = s.split(token).join(val);
      }
      return s;
    }
    return node;
  }
  return walk(template);
}

/** Load the live-verified SDXL inpaint template (never mutated on disk). */
function loadTemplate() {
  return require('./workflows/inpaint.json');
}

/** Build a multipart/form-data body carrying one PNG file under field "image". */
function buildMultipart(buffer, filename, boundary) {
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="image"; filename="${safeName(filename)}"\r\n` +
    `Content-Type: image/png\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return Buffer.concat([head, buffer, tail]);
}

/** Upload a PNG to ComfyUI /upload/image; returns the name to use in LoadImage. */
async function uploadImage(buffer, filename, opts = {}) {
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const boundary = 'raindesk-' + crypto.randomBytes(16).toString('hex');
  const body = buildMultipart(buffer, filename, boundary);

  const res = await doFetch(`${base}/upload/image`, {
    method: 'POST',
    // Content-Length is a forbidden fetch header; undici sets it for Buffer
    // bodies itself — do not set it manually.
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `ComfyUI upload failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => null);
  const name = data && typeof data.name === 'string' ? data.name : null;
  if (!name) throw new HttpError(502, 'ComfyUI upload returned no image name');
  const subfolder = data && typeof data.subfolder === 'string' && data.subfolder
    ? `${data.subfolder}/` : '';
  return subfolder + name;
}

/** Submit a workflow; returns { prompt_id }. */
async function postPrompt(workflow, opts = {}) {
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const payload = JSON.stringify({ prompt: workflow, client_id: CLIENT_ID });
  const res = await doFetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(502, `ComfyUI /prompt failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await res.json().catch(() => null);
  if (!data || typeof data.prompt_id !== 'string') {
    throw new HttpError(502, 'ComfyUI /prompt returned no prompt_id');
  }
  return { promptId: data.prompt_id, number: data.number };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll GET /history/{id} until the prompt settles (status_str success|error).
 * Resolves with the history entry; rejects with HttpError on error/timeout.
 */
async function pollHistory(promptId, opts = {}) {
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const intervalMs = opts.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastSeen = 'pending';

  for (;;) {
    const res = await doFetch(`${base}/history/${encodeURIComponent(promptId)}`);
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const entry = data && data[promptId];
      const status = entry && entry.status && entry.status.status_str;
      if (entry && (status === 'success' || status === 'error')) {
        if (status === 'error') {
          const detail = JSON.stringify(entry.status.messages || []).slice(0, 400);
          throw new HttpError(502, `ComfyUI generation error: ${detail}`);
        }
        return entry;
      }
      if (status) lastSeen = status;
    }
    if (Date.now() + intervalMs > deadline) {
      throw new HttpError(504, `generation timed out (last status: ${lastSeen})`);
    }
    await sleep(intervalMs);
  }
}

/** Collect output image descriptors from a finished history entry. */
function extractImages(entry) {
  const images = [];
  const outputs = (entry && entry.outputs) || {};
  for (const nodeOutput of Object.values(outputs)) {
    for (const img of (nodeOutput && nodeOutput.images) || []) {
      if (img && typeof img.filename === 'string') images.push(img);
    }
  }
  return images;
}

/** Absolute /view URL for an output image descriptor. */
function viewUrl(img, base = DEFAULT_BASE) {
  const b = base.replace(/\/+$/, '');
  const q = new URLSearchParams({
    filename: img.filename,
    subfolder: img.subfolder || '',
    type: img.type || 'output',
  });
  return `${b}/view?${q.toString()}`;
}

/** Fetch the bytes of an output image (used to mirror results locally). */
async function fetchImageBytes(img, opts = {}) {
  const base = (opts.base || DEFAULT_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const res = await doFetch(viewUrl(img, base));
  if (!res.ok) throw new HttpError(502, `ComfyUI /view failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Full inpaint run: validate inputs, upload region + mask, patch the template,
 * submit, poll to completion. Returns { promptId, seed, images, imageUrl }.
 * One call == one ComfyUI job; the caller (lib/queue.js) serializes runs.
 */
async function runInpaint(params) {
  const opts = params.opts || {};
  const template = params.template || loadTemplate();
  const shotId = safeName(params.shotId || 'shot');
  const ts = Date.now();

  validatePngBuffer(params.imageBuffer, 'regionPng');
  validatePngBuffer(params.maskBuffer, 'maskPng');

  const imageRemote = await uploadImage(
    params.imageBuffer, `raindesk-${shotId}-${ts}-region.png`, opts);
  const maskRemote = await uploadImage(
    params.maskBuffer, `raindesk-${shotId}-${ts}-mask.png`, opts);

  const seed = normalizeSeed(params.seed);
  const prefix = params.prefix || `raindesk/${shotId}/${ts}`;
  const workflow = patchWorkflow(template, {
    // Accept both field names: REST sends { prompt }, direct callers may send positive.
    POSITIVE: params.prompt || params.positive || '',
    NEGATIVE: params.negative || '',
    IMAGE: imageRemote,
    MASK: maskRemote,
    SEED: seed,
    PREFIX: prefix,
  });

  const { promptId } = await postPrompt(workflow, opts);
  const entry = await pollHistory(promptId, opts);
  const images = extractImages(entry).filter((img) => (img.type || 'output') === 'output');
  if (!images.length) throw new HttpError(502, 'generation produced no output images');
  return { promptId, seed, images, imageUrl: viewUrl(images[0], opts.base || DEFAULT_BASE) };
}

module.exports = {
  DEFAULT_BASE,
  CLIENT_ID,
  SEED_MAX,
  randomSeed,
  normalizeSeed,
  patchWorkflow,
  loadTemplate,
  uploadImage,
  postPrompt,
  pollHistory,
  extractImages,
  viewUrl,
  fetchImageBytes,
  runInpaint,
};
