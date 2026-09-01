# risks.md — A-G6

| risk | likelihood | impact | mitigation | spike? |
|---|---|---|---|---|
| Journey/CI asserts silently pass against stale v3 reads after cutover (dual stores) | M | H | S3 switches ALL journey workspace reads to `GET /api/workspace/v4` and asserts `schemaVersion: 4`; grep criterion forbids v3 writes in window-manager | NO |
| localStorage unavailable (file://, privacy mode) breaks outbox durability | M | M | warn-once in-memory fallback (notes precedent in app.js); replay becomes best-effort; tests pin the fallback | NO |
| v4 store empty on existing user data (no window_* rows) — first boot seeds from v3 once (seedFromV3) | L | L | already implemented + tested (seeding test); journey empty-mode covers blank state | NO |
| Title split (S0) misses a rename/tab/shelf chip consumer of model.title | M | M | grep all `model.title`/`member.title` readers in the file; discriminator tests for state(), tab label, shelf chip label | NO |
| Fake-DOM tests diverge from real pointer/capture behavior as write paths change | M | M | journey (real Chrome) remains the per-step gate for gesture-dependent steps (6–8, 13–17, 24) | NO |
| Review capacity: crew=1 forces sequential reviewer dispatches | H | L | proven working form (memory: sequential single dispatches); plan S7 reserves the two passes | NO |
| Session compaction mid-cluster loses plan context | M | M | THIS shelf is committed before code; per-step commits + structured milestones; mission ledger updated per fork | NO |
| Partner v4 path regresses pure-v3 targets (panel_*) | L | M | S6 gates on `window_*` prefix only; existing partner tests pin the v3 path | NO |
