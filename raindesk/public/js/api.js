/*
 * Raindesk API client — thin fetch wrappers + gen polling + offline fallback.
 * Contract (server.js @ 5e02d6f):
 *   GET  /api/board            -> { lanes:[...], shots:[...] }
 *   POST /api/board/move       { shotId, lane } -> { ok, board }
 *   POST /api/gen              { shotId, layerId?, prompt, negative?, seed?,
 *                                regionPng(b64), maskPng(b64) } -> { jobId }
 *   GET  /api/gen/{jobId}      -> { id, status: pending|done|error, imageUrl?, error? }
 *   POST /api/shot/{id}/layer  multipart PNG (field "image") -> { ok, file, url, ts }
 *   GET  /api/shot/{id}        -> { id, layers:[{file,ts}], activeLayer }
 *   GET  /api/shot/{id}/image/{file} -> PNG bytes
 *   POST /api/chat             { message } -> { reply }
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RaindeskAPI = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GEN_POLL_MS = 2000;       // 2s cadence
  const GEN_TIMEOUT_MS = 6 * 60 * 1000; // 6 min budget
  const GEN_MAX_ATTEMPTS = 6;     // consecutive transport failures tolerated

  class ApiError extends Error {
    constructor(message, { status = 0, cause = null, friendly = '' } = {}) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.cause = cause;
      this.friendly = friendly || friendlyFor(status, message);
    }
  }

  function friendlyFor(status, message) {
    if (!status || status === 0) return 'can\'t reach raindesk — is the server running? 🌧️';
    if (status === 404) return 'not found — maybe it moved';
    if (status === 400) return `raindesk said no: ${message}`;
    if (status === 413) return 'that image is too big to send';
    if (status === 502 || status === 504) return 'the generator stumbled — try again in a moment ✨';
    if (status >= 500) return 'raindesk hiccuped — try again';
    return message;
  }

  async function jsonFetch(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, opts);
    } catch (e) {
      throw new ApiError(`network error: ${path}`, { cause: e });
    }
    let body = null;
    try {
      body = await res.json();
    } catch (_e) { /* non-JSON (never happens for /api) */ }
    if (!res.ok) {
      const msg = body && body.error ? body.error : `HTTP ${res.status}`;
      throw new ApiError(msg, { status: res.status });
    }
    return body;
  }

  const GET = (path) => jsonFetch(path);

  const POST = (path, payload) => jsonFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload == null ? {} : payload),
  });

  const base64FromBytes = (bytes) => {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(bin);
  };

  /* ------------------------------------------------------------- board */

  function getBoard() { return GET('/api/board'); }

  function moveShot(shotId, lane) { return POST('/api/board/move', { shotId, lane }); }

  /* --------------------------------------------------------------- gen */

  function submitGen({ shotId, layerId, prompt, negative, seed, regionPng, maskPng }) {
    return POST('/api/gen', {
      shotId,
      layerId: layerId || undefined,
      prompt,
      negative: negative || undefined,
      seed: seed === undefined || seed === null ? undefined : seed,
      regionPng: base64FromBytes(regionPng),
      maskPng: base64FromBytes(maskPng),
    });
  }

  /**
   * Poll a gen job to done|error. 2s cadence, 6min budget, up to 6
   * consecutive transport failures tolerated (device sleep, server restart).
   * Returns { status:'done', imageUrl } or throws ApiError(friendly message).
   */
  async function pollGen(jobId, {
    pollMs = GEN_POLL_MS,
    timeoutMs = GEN_TIMEOUT_MS,
    maxTransportFails = GEN_MAX_ATTEMPTS,
    signal = null,
    onPoll = null,
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let fails = 0;
    for (;;) {
      let view;
      try {
        view = await GET(`/api/gen/${encodeURIComponent(jobId)}`);
        fails = 0;
      } catch (e) {
        if (signal && signal.aborted) throw new Error('aborted');
        if (++fails > maxTransportFails) {
          throw new ApiError(`lost track of job ${jobId}`, { cause: e, friendly: 'lost the job — check the server and retry 🌧️' });
        }
        view = { status: 'pending' };
      }
      if (onPoll) { try { onPoll(view); } catch (_e) { /* listener noise */ } }
      if (view.status === 'done') {
        if (!view.imageUrl) throw new ApiError('job done without imageUrl');
        return view;
      }
      if (view.status === 'error') {
        throw new ApiError(view.error || 'generation failed', {
          status: 502,
          friendly: `gen didn't make it — ${view.error || 'unknown error'} · try another take? ✨`,
        });
      }
      if (Date.now() + pollMs > deadline) {
        throw new ApiError(`gen timed out after ${Math.round(timeoutMs / 60000)} min`, {
          friendly: 'gen ran out of time — try again? ⏳',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** Fetch an image URL and decode to { width, height, data:RGBA }. */
  async function fetchImageRGBA(url) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new ApiError(`image fetch failed: ${url}`, { cause: e, friendly: 'couldn\'t load the take — retrying may help' });
    }
    if (!res.ok) throw new ApiError(`image fetch HTTP ${res.status}`, { friendly: 'couldn\'t load the take' });
    const blob = await res.blob();
    const bitmap = await createImageBitmap(blob);
    const w = bitmap.width; const h = bitmap.height;
    // Node-free browser path; browsers round to even is not required here.
    const cx = document.createElement('canvas');
    cx.width = w; cx.height = h;
    const c2d = cx.getContext('2d', { willReadFrequently: true });
    c2d.drawImage(bitmap, 0, 0);
    bitmap.close();
    return { width: w, height: h, data: new Uint8ClampedArray(c2d.getImageData(0, 0, w, h).data) };
  }

  /* -------------------------------------------------------------- shots */

  function getShot(id) { return GET(`/api/shot/${encodeURIComponent(id)}`); }

  function uploadLayer(id, pngBytes) {
    const form = new FormData();
    const name = `layer-${Date.now()}.png`;
    form.append('image', new Blob([pngBytes], { type: 'image/png' }), name);
    return jsonFetch(`/api/shot/${encodeURIComponent(id)}/layer`, { method: 'POST', body: form });
  }

  function shotImageUrl(id, file) {
    return `/api/shot/${encodeURIComponent(id)}/image/${encodeURIComponent(file)}`;
  }

  /* -------------------------------------------------------------- chat */

  function sendChat(message) {
    // 125s > server's 120s pi timeout: the server's own friendly fallback
    // reply wins when pi hangs; this client timeout only catches network-level
    // hangs so the composer can never wedge on typing dots forever.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 125000);
    return jsonFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(timer));
  }

  /* --------------------------------------------------- offline fallback */

  /**
   * Demo shot used when /api/board is unreachable: the app still works
   * standalone (canvas-drawn rain-city base from RaindeskCanvas.paintRainCity).
   */
  const DEMO_BOARD = {
    lanes: ['set', 'in_dev', 'unplanned'],
    shots: [
      { id: 'DEMO', beat: 'offline demo — draw and lasso still work', lane: 'in_dev' },
    ],
    demo: true,
  };

  /** Load board; on any failure resolve the built-in demo board (offline mode). */
  async function getBoardOrDemo() {
    try {
      return { board: await getBoard(), offline: false };
    } catch (e) {
      return { board: DEMO_BOARD, offline: true, error: e };
    }
  }

  return {
    ApiError, GET, POST, base64FromBytes,
    getBoard, getBoardOrDemo, moveShot,
    submitGen, pollGen, fetchImageRGBA,
    getShot, uploadLayer, shotImageUrl, sendChat,
    DEMO_BOARD,
  };
});
