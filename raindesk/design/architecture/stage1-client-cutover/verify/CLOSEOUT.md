# CLOSEOUT — Stage-1 client cutover shelf (S0–S6)

Executed 2026-08-28 on `chatgpt/raindesk-v2-integration`. Every step landed as its own commit with its verify hook run; the cluster is pushed.

| step | commit | verify (run after the last mutation of the step) |
|---|---|---|
| S0 title model/DOM split | `67f8708` | new discriminator (state().title string; span/tab/chip render) + full suite 442/442 |
| S1 v4-client module + api v4 surface | `2042009` | `node --test tests/frontend/v4-client.test.js` 10/10 (receipt replay, terminal-vs-transient, storage probe, spatial shape) |
| S2 boot reconciliation seam | `7f50952` | full suite green + real-Chrome journey `{"ok":true,"steps":25}` zero console errors |
| S3–S5 WindowManager cutover (merged per LEDGER L-3) | `8d04732` | suite 447/447 (8 obsolete v3-class tests retired, 3 v4 replacements); journey 25/25 with server-side witness on `GET /api/workspace/v4`; animatic reload smoke ok; grep criterion: ZERO v3 workspace writes in window-manager.js |
| S6 Partner actions through the v4 executor | `78d01c4` | partner lib tests 4/4 incl. identity-exact revert discriminator; suite 449/449 |
| S7 spec-review repair round | (this commit) | F1: persist() now mints a per-gesture mutationId on the spatial lane (resize discriminator pins it); F2: criterion-2 deterministic reload-no-resurrection test added (lib/tests/workspace-v4-client-outbox.test.js — real store + real client, readV4 + tombstone + legacy-guard witnesses) |
| S7 implementation-review repair round | (this commit) | IF1: the durable v4 client is now constructed BEFORE WindowManager and shared with boot replay (one outbox, one actor — the manager previously fell back to memory-only, making replay() vacuous); IF2: queueIntent builds ops AT SEND TIME (thunks) — structural ops inside the create-response window now carry the adopted generation, never the mint-time 0 (discriminator: immediate-minimise test asserts generation 1) |

## Journey-caught defect (the gate earning its keep)

The first post-cutover journey run FAILED at step 17: `window_scenes create not persisting` — the scenes surface's entityType `sequence_strip` (and beats' `beat_trail`) were absent from the server's v4 `WINDOW_TYPES` allowlist, so `window.create` 400ed on the real wire. Invisible to every canned fixture; caught only by the native run. Fixed in `8d04732`.

## Plan deviation (recorded as L-3)

Shelf steps S3/S4/S5 (init-read, spatial, structural) were merged into ONE cutover commit: with read and write on separate stores, any partial flip ships a broken round-trip (v4 seeds from v3 once; new v3 rows never appear in v4). The design itself treats client migration as one move.

## Honest residuals (unchanged from the deferral register)

- CreativeDesk / WorkspaceShell remain on v3 routes (`world_*`/`panel_*` namespaces) — Stages 2–3 per Round-6 order.
- v3 collection routes (`/api/workspace/groups|shelf|window/delete`) are now caller-free from the freeform manager (grep-proven) but stay in the tree for WorkspaceShell-era clients; removal is the separate design-gated step ("only after repository search proves no caller remains" — WorkspaceShell still calls setViewport/object).
- Outbox durability is localStorage with a call-time-probe fallback (warn-once in-memory); IndexedDB remains unnecessary for bounded entries.
