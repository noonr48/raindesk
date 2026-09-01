# plan.md — Stage-5 skeleton

| id | change | files | verify hook | rollback |
|---|---|---|---|---|
| V1 | `reflow(viewport?)` on WindowManager: reachable-titlebar normalization (clamp frame origin into view with min-size respect), dock re-anchoring (docked surfaces/groups re-derive rail geometry from metrics; out-of-policy → explicit float), stranded-window recovery; app.js wires stage resize → reflow (debounced) | `public/js/window-manager.js`, `public/js/app.js`, tests | unit: seeded extreme rows converge; docks re-anchor; world canonical rects untouched | revert |
| V2 | `bringAllIntoView()` command + journey/dev surface | window-manager + journey | unit: all windows reachable after seeding extremes | revert |
| V3 | The viewport matrix harness: boot at 320×568 / 768×1024 / 1280×720 / 1440×900 / 1920×1080 with seeded extremes; first-load + continuous-resize + reload-equivalence assertions | `dev/browser-freeform-desk-matrix.js` (NEW) | matrix harness green (ok:true per viewport) | delete harness |
| V4 | Gates: suite, journey, smoke, matrix; dual sequential review; closeout; checkpoint | docs | reviewer packets + all gates | docs |

## Dependency Order
V1 (reflow core) → V2 (command) → V3 (matrix harness exercises both) → V4. Group-frame reflow rides V1 (frames are the render source; members need no separate pass).

## Done When
scope criteria 1-3 green; CLOSEOUT written; cluster committed/pushed/reviewed/checkpointed.
