# Adapter-Family — v3 Compatibility Adapters + Migration Hardening — SCOPE

## Mandate (Round-6 verdict §5–§6)
Canonical workspace facts have ONE owner (the v4 store). Compatibility routes are ADAPTERS, never co-owners. One server-side v3→v4 migration with backup; legacy routes translate to v4 intents; Partner receipts carry identity.

## Already shipped (inventory-verified — NOT re-done)
- seedFromV3: gen-1 + persisted incarnations; typed presentations; shelf-wins; collapsed guard; active repair; empty-group dissolve; canonical rows without writable state/groupId/dock.
- STAGE-1 tombstone guard on the legacy object route (both id shapes, typed envelope).
- Partner window_* actions route through v4 applyAction with WindowRef receipts.
- Freeform manager fully cut over (no current-tree freeform caller on legacy routes; Stage-3 retired duplicate writers).

## In scope (the gaps)
- **A1 Migration hardening**: exact .pre-v4.bak backup before atomic replacement; DOCK_EDGES validation everywhere edges are retained (invalid → floating); maximised rows convert to maximised presentation (v3 kept the pre-max rect as restore fallback); duplicate group membership removed deterministically in stored group order + a migration-repair receipt recorded in the doc.
- **A2 Object adapter v4 semantics**: missing window_* IDs → 410 (the freeform manager must use window.create); missing legacy world_*/panel_* IDs with no identity history → generation-1 synthetic v4 create (row lands in BOTH stores in one request); live legacy row updates stay tombstone-safe AND land in v4 spatially; responses carry legacyRevision.
- **A3 Structural adapters**: groups/shelf/window-delete accept baseRevision against legacyRevision, compute the requested diff, execute corresponding v4 intents atomically, return the v3 projection + deprecation metadata.
- **A4 Partner receipts**: verify receipts/inverses carry the exact WindowRef and a revert against a closed-then-reopened window fails INCARNATION_REPLACED (never moves the new incarnation); fix if the verification fails.

## Out of scope (recorded)
- Retiring the legacy routes outright (verdict: temporary adapters, kept while CreativeDesk/WorkspaceShell live in legacy namespaces).
- Client-side durable IndexedDB outboxes (different roadmap block).
- Animatic-line changes beyond verification (convergence + combined baseline already green; Stage-3 lifted the ownership quarantine).
