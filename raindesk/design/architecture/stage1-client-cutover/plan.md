# plan.md — A-G5: ordered steps (each: files · verify hook · rollback)

| id | change | files | verify hook | rollback |
|---|---|---|---|---|
| S0 | title model/DOM split: `model.titleText` (string, always) + `model.titleEl` (span); rename/state/tab paths read titleText | `public/js/window-manager.js`, `tests/frontend/freeform-window-manager.test.js` | new discriminator tests: `state().title` string + tab label equals surface title; full frontend battery | revert S0 commit |
| S1 | v4-client module (actor/incarnation minting, intent+spatial wrappers, in-memory outbox) + api.js v4 fns; UNWIRED | `public/js/v4-client.js` (NEW), `public/js/api.js`, `tests/frontend/v4-client.test.js` (NEW) | `node --test tests/frontend/v4-client.test.js` (mock fetch: receipt replay, typed 409/410 surfaces) | delete module + api fns (unwired) |
| S2 | outbox durability: localStorage persistence, warn-once fallback, `replay()` on freeform boot BEFORE auto-open | `public/js/v4-client.js`, `public/js/app.js` (one call), tests | unit: reload with pending close → replay sends intent → readV4 witness: no resurrection; storage-absent → in-memory fallback + warn | revert S2 commit (module reverts to in-memory only) |
| S3 | init() cutover: restore from `GET /api/workspace/v4` (windows/groups/shelf/focus), rebuild models+groups; journey server asserts switch to v4 reads | `public/js/window-manager.js`, `dev/browser-freeform-desk-journey.js`, `tests/frontend/freeform-window-manager.test.js` | journey steps 1–5, 18–19 green on v4 reads; init unit tests on v4 fixture | revert S3 commit (init reads v3 again) |
| S4 | spatial cutover: persist() → `v4Client.spatial` with mutationId; zIndex/focus flows adopt responses; dock geometry via patch | `public/js/window-manager.js`, tests | journey steps 6–8, 24 green; unit tests assert spatial calls + 410/409 adoption | revert S4 (persist returns to upsert) |
| S5 | structural cutover: close/minimise/restore/groups/shelf/presentation/flags/focus → intents; taxonomy adoption; close stays durable in outbox until tombstone-confirmed | `public/js/window-manager.js`, tests | journey steps 10–17 green; new discriminator: reload mid-close never resurrects; grep criterion #1 zero v3 writes | revert S5 |
| S6 | Partner v4 path: `window_*` targets execute as v4 intents; receipts/inverses carry WindowRef | `lib/partner-actions.js`, `lib/tests/partner-actions.test.js` | lib test: revert of reopened window → 409 INCARNATION_REPLACED; existing partner tests green | revert S6 (v3 path for all targets) |
| S7 | evidence + close: docs (FREEFORM_DESK_V2 §status, STAGE1_V4_DEFERRALS update), full suite + journey + animatic reload smoke, sequential dual review (crew 1), push; then deep-review | docs, no product files | bare `npm test` all green; journey `{"ok":true,"steps":25}`; smoke `ok:true`; two reviewer packets | docs revert only |

## Dependency Order
S0 independent (prevents carrying a known defect into the refactor). S1→S2 (durability builds on the module). S3 after S2 (boot replay precedes restore). S4 after S3 (models carry adopted refs). S5 after S4 (structural paths reuse spatial-adopting models). S6 after S5 (v4 ref-resolution pattern established). S7 last. No forward dependencies.

## Done When
- grep criterion #1 zero matches (scope).
- Outbox reload test green (criterion 2); title discriminator green (3); partner INCARNATION_REPLACED test green (4).
- Full suite + journey + animatic smoke green (5); cluster committed & pushed on `chatgpt/raindesk-v2-integration`; dual review pass recorded.
- Then: Stage-2 (world coordinates) is the next ordered block per Round-6 — NOT in this shelf.
