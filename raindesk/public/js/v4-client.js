/*
 * Raindesk v4 workspace client — Stage-1 cutover S1 (unwired).
 * Owns: actor identity (durable per browser), incarnation minting, the
 * durable intent outbox (localStorage; replay-on-boot), and typed-conflict
 * classification for intent + spatial traffic. WindowManager adopts this in
 * S3–S5; until then nothing in the product calls it.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
  else root.RaindeskV4Client = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ACTOR_KEY = 'raindesk.v4.actor';
  const OUTBOX_KEY = 'raindesk.v4.outbox';
  const OUTBOX_VERSION = 1;
  const OUTBOX_LIMIT = 200;

  // Typed-terminal: the server has SETTLED this intent — replaying can never
  // produce a different outcome, so the outbox entry dies with the error.
  // Everything else (network, 5xx, unknown 4xx) stays durable for replay.
  const TERMINAL_CODES = new Set([
    'IDEMPOTENCY_KEY_REUSED', 'WINDOW_GENERATION_GONE', 'INCARNATION_REPLACED',
    'CONTAINER_CHANGED', 'GROUP_CHANGED', 'MUTATION_ID_REUSED', 'PRESENTATION_NOT_ALLOWED',
  ]);

  function randomHex(len) {
    const out = [];
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.getRandomValues) {
      const buf = new Uint8Array(len);
      c.getRandomValues(buf);
      for (const b of buf) out.push((b % 16).toString(16));
      return out.join('');
    }
    for (let i = 0; i < len; i++) out.push(Math.floor(Math.random() * 16).toString(16));
    return out.join('');
  }

  /** localStorage can throw (privacy mode / file://) — degrade to memory
   * once, visibly (the notes warn-once precedent). */
  function makeStorage(backing, notify) {
    let impl = null;
    let warned = false;
    function get() {
      if (impl) return impl;
      if (backing && typeof backing.getItem === 'function') {
        // Probe with a REAL call: privacy-mode localStorage throws at call
        // time, not property-access time — an access-only probe would let
        // every later throw be swallowed per-call (silent durability loss).
        try { backing.getItem(ACTOR_KEY); return (impl = backing); } catch (_e) { /* fall to memory */ }
      }
      if (!warned) {
        warned = true;
        notify('outbox storage unavailable — pending intents survive reload only in memory');
      }
      return (impl = {});
    }
    return {
      getItem(k) { const s = get(); if (!s || typeof s.getItem !== 'function') return null; try { return s.getItem(k); } catch (_e) { return null; } },
      setItem(k, v) { const s = get(); if (!s || typeof s.setItem !== 'function') return false; try { s.setItem(k, v); return true; } catch (_e) { return false; } },
      removeItem(k) { const s = get(); if (!s || typeof s.removeItem !== 'function') return false; try { s.removeItem(k); return true; } catch (_e) { return false; } },
    };
  }

  function codeOf(error) {
    return error && (error.code || (error.detail && error.detail.code)) || null;
  }

  function V4Client({ api, storage, warn } = {}) {
    if (!api) throw new Error('V4Client requires the api surface');
    const notify = warn || ((msg) => { try { console.warn('[v4]', msg); } catch (_e) {} });
    const store = makeStorage(storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null), notify);

    let actorId = store.getItem(ACTOR_KEY);
    if (!actorId || typeof actorId !== 'string' || actorId.length > 64) {
      actorId = `desk_${randomHex(12)}`;
      store.setItem(ACTOR_KEY, actorId);
    }

    function loadOutbox() {
      let raw = null;
      try { raw = store.getItem(OUTBOX_KEY); } catch (_e) { raw = null; }
      if (!raw) return { v: OUTBOX_VERSION, entries: [] };
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || parsed.v !== OUTBOX_VERSION || !Array.isArray(parsed.entries)) throw new Error('bad outbox');
        return parsed;
      } catch (_e) {
        notify('outbox unreadable — starting fresh (server truth wins)');
        return { v: OUTBOX_VERSION, entries: [] };
      }
    }
    function saveOutbox(boxState) {
      if (boxState.entries.length > OUTBOX_LIMIT) boxState.entries = boxState.entries.slice(boxState.entries.length - OUTBOX_LIMIT);
      store.setItem(OUTBOX_KEY, JSON.stringify(boxState));
    }

    let box = loadOutbox();

    function mintIntentId() { return `i${Date.now().toString(36)}_${randomHex(6)}`; }
    function mintIncarnation(windowId) {
      const clean = String(windowId || 'w').replace(/[^a-z0-9_]/g, '').slice(0, 32);
      return `inc_${clean || 'w'}_${randomHex(8)}`.slice(0, 64); // 8..64 chars, control-char free
    }

    function enqueue(op) {
      const entry = { intentId: mintIntentId(), op, createdAt: new Date().toISOString() };
      box.entries.push(entry);
      saveOutbox(box);
      return entry;
    }
    function dequeue(intentId) {
      box.entries = box.entries.filter((e) => e.intentId !== intentId);
      saveOutbox(box);
    }

    async function send(targetActor, intentId, op) {
      try {
        return await api.applyWorkspaceIntent({ actorId: targetActor, intentId, op });
      } catch (error) {
        if (codeOf(error) && TERMINAL_CODES.has(codeOf(error))) error.v4Terminal = true;
        throw error;
      }
    }

    /** intent(op) — enqueue-first (durably), then send. Terminal typed
     * conflicts settle the entry; transient failures leave it for replay(). */
    async function intent(op, { durably = true } = {}) {
      const entry = durably ? enqueue(op) : { intentId: mintIntentId() };
      try {
        const response = await send(actorId, entry.intentId, op);
        if (durably) dequeue(entry.intentId);
        return response;
      } catch (error) {
        if (durably && error && error.v4Terminal) {
          dequeue(entry.intentId);
          if (codeOf(error) === 'IDEMPOTENCY_KEY_REUSED') notify(`intent key reuse (${entry.intentId}) — client bug, entry dropped`);
        }
        throw error;
      }
    }

    /** Boot reconciliation: resend every durable pending intent once. The
     * server's receipts make replays idempotent; unresolved transient
     * failures stay pending with the caller's warn surface. */
    async function replay() {
      const results = { replayed: 0, resolved: 0, remaining: 0 };
      for (const entry of box.entries.slice()) {
        results.replayed += 1;
        try {
          await send(actorId, entry.intentId, entry.op);
          dequeue(entry.intentId);
          results.resolved += 1;
        } catch (error) {
          if (error && error.v4Terminal) { dequeue(entry.intentId); results.resolved += 1; }
        }
      }
      results.remaining = box.entries.length;
      return results;
    }

    /** Spatial patch for an exact incarnation — no outbox (spatial traffic
     * is high-frequency; dedupe rides the server's mutationId ledger and the
     * caller re-commits the latest geometry on the next gesture). */
    function spatial(ref, patch, mutationId) {
      return api.patchWorkspaceSpatial(ref.windowId, ref.generation, {
        incarnationId: ref.incarnationId,
        ...(mutationId ? { mutationId } : {}),
        patch,
      });
    }

    return {
      actorId: () => actorId,
      intent, spatial, replay, mintIncarnation,
      outbox: () => ({ size: box.entries.length, entries: box.entries.map((e) => ({ intentId: e.intentId, kind: e.op && e.op.kind })) }),
    };
  }

  return { V4Client, ACTOR_KEY, OUTBOX_KEY, OUTBOX_VERSION };
});
