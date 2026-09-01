# scope.md — Stage-3: bespoke ownership retirement (Round-6 [major] app.js finding)

## Problem
Freeform mode initializes overlapping owners (Round-6 GPT_PRO_ROUND6_VERDICT.md:21): a legacy BeatTrail is constructed before the mode decision; opening the registry Beats surface constructs another and overwrites `state.beatTrail` — destroying that controller leaves the original present but unreachable through shot-switch/Partner-refresh paths. Layers and Scenes are registered with WorkspaceShell even when registry-owned equivalents are open. These owners remain independent workspace writers (legacy panel_* writes can mutate registry-owned surfaces' rows).

## In Scope
- Ownership decided BEFORE constructing controllers in freeform mode: no WorkspaceShell registration for surfaces the registry owns (layers, scenes — mirroring the existing panel_beats gate).
- One stable façade per logical surface: `state.beatTrail` remains valid through open/close/reopen/shot-switch/Partner-refresh; window-controller destroy never strands the façade.
- Discriminators: constructor/DOM-owner counts for Layers, Scenes, Beats in freeform mode (exactly one of each through open/close/reopen/reload); no legacy `panel_*` write path may mutate a registry-owned row.

## Out of Scope
- Group-frame model (Stage 4), viewport recovery/matrix (Stage 5), keyboard/a11y (Stage 6).
- Removing the legacy panels for NON-freeform mode (default experience unchanged).
- CreativeDesk store migration (world_*/panel_* namespaces stay on v3 stores).

## Success Criteria (measurable)
1. BINARY: in ?freeform=1, workspaceUI.registerPanel is never called for layers/scenes (unit/grep discriminator); panel_beats gate unchanged.
2. BINARY: `state.beatTrail` survives window close/reopen + shot switch + Partner refresh in freeform mode (façade always reachable, never dangling).
3. Suite green; journey 26/26; animatic smoke ok (regression).

## Constraints — Round-6 order (Stage-3 after coordinates); default (non-freeform) experience byte-identical; one owner per fact (SSOT).
