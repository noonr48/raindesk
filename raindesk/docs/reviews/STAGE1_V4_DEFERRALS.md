# STAGE-1 v4 layer — accepted risks & deferred items

Recorded 2026-08-27 after the dual-lens review cycles: `b8cbaed` (blocked, 11 findings) → `d074732` (repairs) → advisory-closure tip.
Scope context: STAGE-1 lib/server layer, PRE-cutover, single-user desk, Node single-process. Each item names the stage where it must be revisited.

- **F5 — whole-file save per intent/spatial PATCH** (`atomicWrite` on every `applyIntent`/`applySpatial`): O(file) per write, O(n²) cumulative under drag storms. ACCEPTED at STAGE-1 write rates. REVISIT at cutover: debounce spatial saves or split spatial persistence from the receipt ledger.
- **F7 — save() outside the handler try** (cache stays mutated if the disk write fails; an in-memory retry then replays success) **+ two-process first-boot seed race** (no lockfile; divergent seeds possible). ACCEPTED under the single-process deployment assumption. REVISIT with any multi-instance support.
- **F8 — `{...row}` shallow copies share nested `spatial`/`presentation` objects with the live store.** HTTP-safe today (responses stringify synchronously); LATENT hazard for in-process consumers. REVISIT at cutover: clone at the client boundary (structuredClone).
- **F9 — incarnation echo has no ownership check**: any actor that observed a live incarnation can re-request its create and get an idempotent success echo (no state change). ACCEPTED: create-success is public-idempotent semantics.
- **Mutation ledger bodyHash** (added post-d074732): same (windowId, generation, mutationId) with a DIFFERENT patch now refuses `409 MUTATION_ID_REUSED` instead of acking an unapplied patch. Semantic-equal-but-reordered patch JSON hashes differently — same documented limitation as receipt bodyHash.
- **Viewport bounds**: zoom > 0 only; huge-but-finite values accepted (JSON-safe). `changed.viewport` echoes exactly what applied.
- **expectedLastGeneration stays ADVISORY by design** — recorded on receipts, never gating (no compare-and-swap magnet).
- **Latent hardening (non-blocking)**: `assertSafeKeyComponent`'s length cap lives at the call sites (applyIntent ≤64, mutationId ≤64); applySpatial validates windowId/generation before any ledger lookup.
