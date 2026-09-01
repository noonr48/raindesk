# contracts.md — A-G4: seam contracts for the cutover

## V4Client.intent(op)
- **Surface:** `public/js/v4-client.js` → `api.applyWorkspaceIntent` → `POST /api/workspace/v4/intents`
- **Signature:** `intent(op: {kind, …}) → Promise<response>` where response = `{ok, actorId, intentId, duplicate, structuralRevision, spatialRevision, viewportRevision, changed{…}, receipt}`
- **Preconditions:** op.kind in server op set; actorId minted; (durably) entry appended to outbox BEFORE the fetch.
- **Postconditions:** on success the response is adopted (refs/revisions) and the outbox entry removed; replay of the same (actorId,intentId,body) returns the identical outcome.
- **Errors:** 409 IDEMPOTENCY_KEY_REUSED (client bug — warn loudly, drop entry); 410 WINDOW_GENERATION_GONE with `tombstone` (own incarnation closed → drop local model); 409 INCARNATION_REPLACED / CONTAINER_CHANGED / GROUP_CHANGED with `live`/`shelf`/`group` (adopt canonical payload, refetch readV4); 422 PRESENTATION_NOT_ALLOWED (surface policy — reject locally, no retry); 4xx/5xx others → keep outbox entry, warn-once.
- **Idempotency:** yes — server receipts; outbox replays are same-key-same-body.
- **Versioning:** additive op kinds only.

## V4Client.spatial(ref, patch)
- **Surface:** `public/js/v4-client.js` → `api.patchWorkspaceSpatial` → `PATCH /api/workspace/v4/windows/:id/:gen/spatial`
- **Signature:** `spatial(ref: WindowRef, patch: {x?,y?,width?,height?,zIndex?…}, mutationId?) → Promise<{window, spatialVersion, spatialRevision}>`
- **Preconditions:** ref matches the live row (generation+incarnation); patch keys finite.
- **Postconditions:** window.spatial adopted; version counters monotonic.
- **Errors:** 410 WINDOW_GENERATION_GONE (generation gone → drop/refetch by `live`); 409 INCARNATION_REPLACED (refetch canonical); 409 MUTATION_ID_REUSED (client bug — warn); 400 finite violations.
- **Idempotency:** mutationId dedupe scoped (windowId,generation,mutationId) + bodyHash.
- **Versioning:** additive patch keys.

## Outbox.replay()
- **Surface:** `public/js/v4-client.js`; invoked by app.js freeform boot BEFORE WindowManager auto-open.
- **Signature:** `replay() → Promise<{replayed, resolved, remaining}>`
- **Preconditions:** none (no-op when empty).
- **Postconditions:** every durable pending intent re-sent; resolved entries removed; still-failing entries remain with warn-once.
- **Errors:** network/5xx → entries stay pending; boot proceeds (windows restore from readV4 — server truth wins over stale outbox).
- **Idempotency:** inherent (receipts).
- **Versioning:** outbox schema versioned `v` field; unknown version → clear with warn (fresh start beats corrupt replay).

## WindowManager v4 write paths
- **Surface:** `public/js/window-manager.js` — persist(model)→spatial; close/minimise/restore/group/join/tear/switchTab/presentation/flags/focus→intents; init()→readV4.
- **Signature:** unchanged public API (`open/close/minimise/…/init/state/list`).
- **Preconditions:** v4-client present (feature-gated `?freeform=1`).
- **Postconditions:** zero v3 workspace calls (grep criterion); server state converges to user intent; local models carry adopted WindowRefs.
- **Errors:** per taxonomy above; every drop/refetch decision named per code.
- **Idempotency:** every path.
- **Versioning:** n/a (internal).

## Partner workspace action (v4 path)
- **Surface:** `lib/partner-actions.js` applyAction/execute path for `window_*` targets → workspace-v4 intents server-side.
- **Signature:** action {kind: move/dock/focus/open_panel/close_panel, targetId…} + resolved WindowRef → receipt {ref} + inverse {ref, undo op}.
- **Preconditions:** target resolves to a LIVE v4 row (`window_*`); non-`window_*` targets keep the existing v3 path (Stage 2/3 boundary).
- **Postconditions:** receipt and inverse store the exact WindowRef.
- **Errors:** INCARNATION_REPLACED on stale/closed-and-reopened targets (revert must fail, never move the new incarnation).
- **Idempotency:** intent receipts; inverse application is itself an intent.
- **Versioning:** additive.
