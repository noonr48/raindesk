# CLOSEOUT — Stage-3 bespoke ownership retirement (T1–T3)

Executed 2026-09-01 on `chatgpt/raindesk-v2-integration`.

| step | commit | verify (run after the step's last mutation) |
|---|---|---|
| Shelf | `3ccc678` | scope + T1-T4 skeleton |
| T1/T2 | `6964652` | discriminator pins the ownership shapes; suite 462/462; journey 26/26 zero console errors; freeform-desk smoke ok (default+freeform boot) |
| T3 audit | `7b4c397` | VACUOUS-BY-T1: the legacy write path (workspace-ui persist → upsertWorkspaceObject) only fires for REGISTERED panels; registry surfaces unregistered in freeform mode; app.js carries zero upserts; tombstone + v4-routing guards independently protect window_* rows |
| Dual review | — | spec lens VERDICT pass FINDINGS none FOLLOW-UPS none (all 7 clauses file:line-verified); implementation lens VERDICT pass FINDINGS none with 4 non-blocking follow-ups (below) |

## What changed

- The mode flag is computed BEFORE the legacy BeatTrail construction and gates it: in freeform mode the registry owns Beats (mountBeatTrail builds the trail INTO the window); no unreachable duplicate, no dangling façade.
- Layers + Scenes WorkspaceShell registrations gated behind `!useFreeformDesk` (mirroring the pre-existing panel_beats gate): their only opener was the registration, so the legacy DOM stays inert; default mode is byte-identical.
- The layers tool routes surface-first (`toggleLayersSurface` — open/restore/minimise the registry window, false → legacy `togglePanel` fallback; structural mirror of `toggleBeatsSurface`).
- `persist()` adoption now re-renders the live frame — the smoke caught a 0.377px reload drift when the last drag render kept the unrounded projection while reload rendered the rounded one.

## Named follow-ups (implementation lens; non-blocking, recorded — not silent)

1. The freeform try-block's swallowed throw (app.js ~:672) would leave freeform mode with no layers/scenes/beats openers and silently no-op tool clicks until reload — add a one-time console.warn + fallback registration on catch when the freeform block is touched next.
2. A beats-tool click in the boot window (between flag computation at :405 and freeform construction at ~:614) is a silent no-op (`state.freeform` unset, legacy trail never constructed) — acceptably narrow; revisit if the boot sequence grows.
3. The indexOf-based discriminator tests false-block on rename-only refactors of `useFreeformDesk`/panel ids — keep anchors coarse when refactoring those names.
4. A hypothetical server/partner path minting a `beat_trail` row under a non-`window_beats` id would strand the first trail's shot-refresh on a second mount — no such writer exists today (open() mints default ids; no lib window.create writer for beat_trail).
