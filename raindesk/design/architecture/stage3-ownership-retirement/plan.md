# plan.md — Stage-3 skeleton

| id | change | files | verify hook | rollback |
|---|---|---|---|---|
| T1 | Freeform mode skips WorkspaceShell registration for registry-owned surfaces (layers, scenes) — the panels exist in DOM but the shell never owns/moves them; mirrors the existing panel_beats gate | `public/js/app.js` | unit/grep discriminator: registerPanel calls for panel_layers/panel_scenes gated by !useFreeformDesk; default mode unchanged | revert gate |
| T2 | BeatTrail façade: the legacy trail is constructed ONLY when its owner needs it (non-freeform default OR freeform before the registry window opens it — decide); mountBeatTrail's overwrite keeps a destroy-safe façade (state.beatTrail never dangles; destroy restores the prior valid target or null) | `public/js/app.js` | discriminator: close+reopen the beats window, switch shots, fire a Partner refresh — state.beatTrail always valid | revert |
| T3 | Legacy panel_* writes never mutate registry-owned rows: WorkspaceShell persistence (persist → upsertWorkspaceObject on panel ids) is inert for layers/scenes panels in freeform mode (they're display-only DOM or not registered at all) | `public/js/workspace-ui.js` (if needed) | discriminator: no upsertWorkspaceObject call carries a registry-owned surface id from the legacy path | revert |
| T4 | Gates: suite, journey, animatic smoke, dual sequential review, push, closeout | docs | reviewer packets | docs |

## Dependency Order
T1 first (pure gating, zero behavior change in default mode). T2 after T1 (façade semantics). T3 audit may be vacuous if T1 removes the writers. T4 last.

## Done When
scope criteria 1-3 green; CLOSEOUT written; cluster committed/pushed/reviewed.
