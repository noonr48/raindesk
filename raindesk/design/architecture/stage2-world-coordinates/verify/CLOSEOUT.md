# CLOSEOUT — Stage-2 canonical world coordinates (P0–P4)

Executed 2026-08-28 on `chatgpt/raindesk-v2-integration`. Round-6's [critical] finding — two coordinate authorities (CreativeDesk world units vs WindowManager stage pixels) — is closed for every freeform surface.

| step | commit | verify (run after the step's last mutation) |
|---|---|---|
| P0 projection extraction (pure) | `023b8e6` | creative-desk tests 4/4 green UNCHANGED (extraction purity); suite 451/451 |
| P1 coordinateSpace classification | `fcb15b2` | registry discriminator (world default, explicit screen, bad values rejected; 7 shipped surfaces world-classified); suite 452/452 |
| P2 walking skeleton (uniform world path) | `c2391f5` | world-rect invariance discriminator (pan/zoom never rewrite the canonical rect; drag deltas unproject at live scale; spatial PATCH carries world units); journey 25/25 zero console errors; suite 453/453 |
| P3 client-informed backfill | `5f11300` | legacy screen-row discriminator (restore converts through the LIVE viewport+metrics — position AND size unproject — and re-persists canonical world geometry); journey 25/25; animatic reload smoke ok; suite 454/454 |
| P4 birth-flag validator + placement audit | `a2a239b` | birth-space discriminator (world creates carry space:world, chrome space:screen); suite 455/455 |

## Scope criteria (scope.md)

1. **Beside-artwork invariance (criterion 1)** — substantively green: the P2 discriminator pins canonical-rect invariance under pan/zoom; the journey's step-19 geometry-across-reload, step-8 dock round-trip, steps 10–17 (minimise/restore/group/tear) all run on the world path with the canonical rect untouched (docks render a screen rail from the edge — the world rect stays latent behind the presentation, per the Round-6 rule).
2. **No mixed authority (criterion 2)** — green at birth and at restore: creates birth-flag their space (P4); legacy screen rows convert at restore (P3) — and no server-side behavior branches on the stale flag (verified by grep; honest residual below).
3. **Gates** — suite 455/455; journey 25/25 zero console errors; animatic reload smoke ok.

## Journey-caught defects (fixed en route)

- `creative-desk.js` browser-branch acquisition referenced `root` outside its factory scope (node tests pass via require; only the browser died) — fixed with a `typeof window` guard.
- The initial 40-unit world cascade stacked siblings so heavily that a journey drag RELEASE landed inside another window — accidental drop-to-group; widened to a 520-unit cascade.
- `persist` rounded for the wire but left the live model unrounded — 0.27px projection drift across reload broke exact geometry witnesses; persist now ADOPTS its committed rounding into the model.
- snapPlace consumed world-unit rects directly — edge detection now projects into screen space first (and a docked model being dragged detects from its latent rect's projection, not the rail it is leaving).

## Honest residuals

- Legacy rows keep a stale declarative `space:"screen"` flag after client-side conversion — and the ONE server branch that read it (the v4 partner dock_panel guard) was REMOVED in the clause-7 repair: it was stale v3 thinking that blocked exactly the legitimate case (partner-docking a birth-flagged space:'world' desk surface; world_* artwork never routes through the v4 partner lane — the v3 executor keeps its own guard). Post-repair, no server behavior branches on `row.space` for window_* rows (grep-verified); the flag trues up when a window is recreated. Revisit if any future server behavior branches on `row.space` (LEDGER L-4 would-change-mind).
- CreativeDesk/WorkspaceShell still own their own render loops (Stage-3 owner retirement; they already consume the shared projection module for math).
- defaultPlacement is now screen-chrome-only; world surfaces place via the cascade (P4 audit).
