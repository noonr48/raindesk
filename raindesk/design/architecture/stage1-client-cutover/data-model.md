# data-model.md — A-G3: entities & SSOT for the cutover

## Entities
- **V4Workspace** — canonical workspace store (schema v4) for `window_*` surfaces. Already exists.
- **WindowRef** — `{windowId, generation, incarnationId}`; identity of one window incarnation. generation server-minted; incarnationId client-minted (v4-client), 8..64 chars, no control chars.
- **IntentReceipt** — server record keyed `(actorId, intentId)`; same-body replay returns original response; different body → 409.
- **ClientOutbox** — ordered list of pending intents `{actorId, intentId, op, createdAt}` persisted client-side; replayed on boot before auto-open; entries removed only on server response/receipt confirmation.
- **ActorId** — stable per-browser id (`raindesk.v4.actor`), minted once; `desk_<random>`.
- **SpatialMutation** — server dedupe keyed `(windowId, generation, mutationId)` + bodyHash.

## Fields
### WindowRef
| field | type | nullable | default |
|---|---|---|---|
| windowId | string (ID_RE) | no | — |
| generation | int | no | server: lastGeneration+1 |
| incarnationId | string 8..64 | no | client-minted uuid |

### ClientOutbox
| field | type | nullable | default |
|---|---|---|---|
| actorId | string | no | — |
| intentId | string | no | `i_<seq>_<random>` |
| op | object {kind,…} | no | — |
| createdAt | ISO string | no | now |

## Relations
- V4Workspace 1:N WindowRef (via windows[] rows + identities map). Groups reference WindowRefs (members[]); shelf references WindowRefs.
- WindowManager in-memory model 1:1 ↔ live v4 row (model.ref adopted from responses). ClientOutbox N:1 ActorId.

## Invariants
- Every WindowManager structural mutation for `window_*` flows outbox→intent; NONE writes v3.
- A tombstoned incarnation can never reappear in any client cache: 410 → drop local model (or refetch canonical when `live` differs).
- Outbox entries are removed ONLY by confirmed response/receipt; replay is idempotent by construction (same key+body).
- `state().title` is ALWAYS a string (titleText); the span node is `model.titleEl` — never assigned to `model.title`.

## State Owner (per entity)
- V4Workspace / WindowRef generations / receipts / tombstones → `lib/workspace-v4.js` (sole author).
- incarnationId minting → `public/js/v4-client.js` (client-side, before first create).
- ClientOutbox → `public/js/v4-client.js` (sole author; WindowManager only calls intent()).
- ActorId → `public/js/v4-client.js`.
- WindowManager models → cache derived from v4 responses (READER of truth; never authoritative for `window_*`).

## SSOT Declaration
- `window_*` truth = v4 store. REJECTED: WindowManager stays authoritative and syncs to server — dual ownership, the exact drift the protocol kills.
- REJECTED: dual-write v3+v4 during migration — namespaces are disjoint; no writer needs both.
- Outbox storage REJECTED alternative: IndexedDB — over-engineering for bounded string entries; localStorage with warn-once in-memory fallback matches the notes precedent.
- Group membership canonical = v4 groups[] (server); REJECTED: client-side `groups` Map as truth — it becomes a render cache rebuilt from readV4/responses.

## Migration Notes (expand-contract)
- EXPAND: v4-client + api fns added beside v3 (unwired) → WindowManager switched within `?freeform=1` → journey/tests flipped to v4 reads.
- CONTRACT: remove v3 write calls from window-manager.js (grep proof), then LATER (separate step, post no-caller proof) remove v3 collection routes.
