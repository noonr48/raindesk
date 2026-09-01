# plan.md — Stage-3 skeleton

| id | change | files | verify hook | rollback |
|---|---|---|---|---|
| T1 | Freeform mode skips WorkspaceShell registration for registry-owned surfaces (layers, scenes) — the panels exist in DOM but the shell never owns/moves them; mirrors the existing panel_beats gate | `public/js/app.js` | unit/grep discriminator: registerPanel calls for panel_layers/panel_scenes gated by !useFreeformDesk; default mode unchanged | revert gate |
| T2 | BeatTrail façade: the legacy trail is constructed ONLY when its owner needs it (non-freeform default OR freeform before the registry window opens it — decide); mountBeatTrail's overwrite keeps a destroy-safe façade (state.beatTrail never dangles; destroy restores the prior valid target or null) | `public/js/app.js` | discriminator: close+reopen the beats window, switch shots, fire a Partner refresh — state.beatTrail always valid | revert |
| T3 | VACUOUS-BY-T1 (audit closed): the legacy write path is WorkspaceShell's drag persistence (workspace-ui.js persist() → upsertWorkspaceObject, :160-166) which only fires for REGISTERED panels; registry-owned surfaces (layers/scenes/beats) are unregistered in freeform mode after T1, and app.js carries zero upsertWorkspaceObject calls — no legacy panel_* write can mutate a registry-owned row. The workspace-ui.js:23-25 panel_* references are default placement SEEDS (read at registration), not write paths. The v4 tombstone guard independently protects window_* ids on the legacy route | audit (this row) | grep evidence above + T1 discriminator | n/a |
| T4 | Gates: suite, journey, animatic smoke, dual sequential review, push, closeout | docs | reviewer packets | docs |

## Dependency Order
T1 first (pure gating, zero behavior change in default mode). T2 after T1 (façade semantics). T3 audit may be vacuous if T1 removes the writers. T4 last.

## Done When
scope criteria 1-3 green; CLOSEOUT written; cluster committed/pushed/reviewed.
