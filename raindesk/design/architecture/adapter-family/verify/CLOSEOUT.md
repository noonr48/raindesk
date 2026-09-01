# Adapter-Family — v3 Compatibility Adapters + Migration Hardening — CLOSEOUT

Cluster a65aee4..bd4c280 · branch chatgpt/raindesk-v2-integration · suite 500/500 · journey 38 steps (zero console errors) · matrix 6/6 · smoke ok

## What shipped (A1–A4)
- **A1 Migration hardening** (af650c4): exact .pre-v4.bak backup written exactly once before the v3→v4 atomic replacement; DOCK_EDGES validation everywhere edges are retained (invalid → floating, one reconciliation pass); maximised rows convert to the typed maximised presentation (v3 rect as the floating fallback); duplicate membership resolves in stored group order with an auditable migration-repair receipt (keptBy/removedFrom). RECORDED BOUNDARY: the v3 reader itself sanitizes duplicates before the migration boundary — the seed dedupe is defense-in-depth (discriminator injects hostile v3 past the reader via require-cache stub).
- **A2 Object route as v4 adapter** (4ef9c65): missing window_* ids → 410 WINDOW_NAMESPACE_RESERVED (the freeform manager must use window.create); missing legacy ids → generation-1 synthetic v4 window.create (row lands in BOTH stores in one request, v4 first; v3-only types shot/comic_page map to generic_panel while v3 keeps its native type); live legacy updates land in v4 spatially (incarnationId-keyed; typed failures surface, never a silent mirror gap); responses carry legacyRevision.
- **A3 Structural routes as diff-to-intent adapters** (9d4008f): groups/shelf/window-delete compute the requested diff and land it in v4 FIRST (canonical authority; typed failures surface with nothing written), then the v3 write lands as the projection. Groups → group.create/join/leave/activate/dissolve; shelf → minimise/restore diffs; delete → identity-exact window.close tombstone. baseRevision pre-gates against the v3 revision it fronts (== legacyRevision, coupled via bumpLegacyRevision). Responses carry deprecation metadata. (Includes the delete-route precedence fix — the existence guard compared against the body object so the stale gate never ran.)
- **A4 Partner identity receipts** (bd4c280, verification-only — the wiring already held): receipts and inverses carry the exact full WindowRef; revert after close+reopen fails 409 INCARNATION_REPLACED with the new incarnation untouched and the revert retryable.

## Inventory-verified already-shipped (not re-done)
seedFromV3 core (gen-1 + incarnations, typed presentations, shelf-wins, collapsed guard, active repair, empty-group dissolve, canonical rows without writable state/groupId/dock); STAGE-1 tombstone guard on the object route; Partner window_* routing through v4 applyAction; the freeform manager fully on v4 with zero current-tree freeform callers on the legacy structural routes (grep-verified at closeout).

## Gates at bd4c280
suite 500/500 · journey {ok:true,steps:38} zero console errors · matrix 6/6 (incl. 2560×1080) · smoke ok · 12 new discriminators across 4 new test files + 1 hardened existing file.

## Honest limitations
- The groups diff translator is coarse-grained per-group (membership diff + activate), not a full reorder translator (group.reorder exists on the v4 lane; legacy setGroups carries no order semantics beyond windowIds — mapped as leave/join).
- v4-mirror failures on structural routes surface typed but leave the request half-served only in the v3-write-fails-after-v4 path (single-process sequential; no such failure observed; the next request re-syncs from v4).
- The .pre-v4.bak backup is best-effort (a read-only data dir proceeds without it — logged in code, not silently).

## Scope deviations
None. Out-of-scope items recorded in scope.md (route retirement, client durable outboxes, animatic changes beyond verification).
