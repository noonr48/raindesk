# Raindesk continuation decision ledger

### L-1 — Converge animatic and freeform before or after STAGE-2?
Phase: continuation framing, before any code mutation
Options:
  A Freeform-first — works because `eee5ede` is coherent / dead if later integration replays Stage-2 work across ≥3 high-fan-in files.
  B Converge-now — works because remaining stages evolve the actual combined product once / dead if the merge conflict set is unbounded or semantically ambiguous.
Chosen: B, gate-first — deciding criterion: council 5/5 plus merge-tree footprint (79 animatic paths, 33 freeform paths, overlap only index.html + server-core.js, one content conflict; server-core auto-merges).
Rejected: A loses because it defers a mandatory merge while adding portability/replay assumptions; retained only as fallback if the combined baseline cannot keep both estates green — it could (441/441, journey 25/25, animatic reload ok, dual review pass, b452dd1 pushed).
Resources: consulted Round-6 verdict, structured project ledger, live branch graph, remote refs, v3/v4 caller census, five isolated council lenses, merge-tree/overlap census, combined-baseline runtime gate; deliberately did NOT use Pro bridge because local evidence decisively falsified the unbounded-merge risk.
Would change my mind: the disposable combined baseline cannot retain both validated test estates and one real v4 lifecycle without deleting product behavior. (Not fired.)

### L-2 — Parallel recon wave vs degraded crew after restart?
Phase: architecture cartography launch
Options:
  A Re-dispatch the five-lane xna-analyst wave — works because lanes are non-overlapping / dead if crew cap stays 1 (harness rejects; serial children lose wave semantics).
  B Parent-owned recon (direct reads + CBM structural graph) + one scout — works because the parent already holds most context / dead if scale exceeds parent budget.
Chosen: B — deciding criterion: harness rejected the 5-lane re-dispatch (crew 1); no partial work existed (0/5 started, nothing to resume).
Rejected: A unavailable this session (crew cap), not wrong; re-raise when crew ≥2.
Resources: consulted swarm registry (0/5 skipped), CBM index (3118 nodes/9890 edges), direct file reads; scout dispatched for the one lane needing independent breadth — DIED on provider usage limit (failover glm-5.3); its scope was already covered by parent reads; no resume needed (DO-NOT-RETRY: scout run 2d711227 empty, partial).
Would change my mind: crew size restored ≥2 while broad multi-seam recon is still open.

STATE: integration branch b452dd1 pushed (441/441, journey 25/25, animatic reload ok, dual review pass). Architecture shelf for Stage-1 client cutover (S0–S7) committed at design/architecture/stage1-client-cutover/.
LIVE THREADS: execute shelf steps S0→S7 sequentially; per-step commits; sequential dual review at S7 (crew 1).
OPEN FORKS: none; Stage-2 world-coordinate shelf comes AFTER cutover per Round-6 order.
NEXT ENTRY POINT: S0 — title model/DOM split in public/js/window-manager.js with discriminator tests, then S1 v4-client module.

### L-3 — Shelf steps S3/S4/S5 as three commits, or one cutover commit?
Phase: S2 landed (boot seam), before WindowManager cutover
Options:
  A Three incremental commits (init-read-v4, then spatial, then structural) — works if each intermediate state is coherent / dead if read and write cutovers disagree: init reading v4 while persist still writes v3 breaks the round-trip (v4 seeds from v3 ONCE; new v3 rows never appear in v4 — restored desks would silently lose every window opened after the flip).
  B ONE cutover commit flipping read AND write together — works because the design itself treats client migration as one move ("Move WindowManager to v4 create/intent/spatial APIs and durable outbox" is a single migration-order step) / dead if the commit grows too large to review — mitigated by the shelf's per-path contracts already naming every seam.
Chosen: B — deciding criterion: store coherence trumps commit granularity; a partial flip is not a shippable intermediate state.
Rejected: A — each intermediate state ships a broken round-trip.
Resources: consulted workspace-v4 seeded-once code (read) + STAGE-1 DESIGN migration order; did NOT consult reviewers pre-hoc (S7 dual review covers the merged commit).
Would change my mind: the merged red-test surface proves unmanageable mid-flight (then split along read-only vs write-only seams, still shipping both before journey runs).

STATE: S0 67f8708, S1 2042009, S2 7f50952 pushed; cutover (merged S3-S5) in flight.
NEXT ENTRY POINT: read OPS payloads (group.*, setFlags, close), rewrite WindowManager write/read paths, rebase frontend tests to v4 adapters, switch journey server asserts to GET /api/workspace/v4, suite+journey, commit as the cutover.

### L-4 — P3 backfill: server-side migration vs client-informed conversion?
Phase: Stage-2 P3 (post-P2 skeleton)
Options:
  A Server-side one-time v4 migration using the persisted viewport — works if the transform is fully known server-side / dead if it is not: worldToScreen needs baseScale(metrics)*zoom and the screen centre — the server owns NEITHER the stage metrics nor the render-time viewport semantics; an assumption-based conversion drifts every legacy rect.
  B Client-informed conversion at restore — the restoring client owns live metrics + getViewport, so screenToWorld is EXACT per conversion; corrected world geometry re-persists immediately (durable spatial PATCH); new creates flag their coordinateSpace at birth — dead if the stale declarative space flag on legacy rows gates any server behavior.
Chosen: B — deciding criterion: conversion exactness (the server cannot know the stage size).
Rejected: A loses precision on the very first legacy row for any non-default stage.
Resources: checked server-side space consumers (grep: readV4 exposure only — no validation branches on it); stale flags on legacy rows recorded as an honest residual until those windows are recreated.
Would change my mind: any future server-side behavior that branches on row.space — then a server reclassify op or store migration becomes required.
