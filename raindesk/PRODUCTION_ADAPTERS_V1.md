# Raindesk Production Adapter Registry v1

Production Adapter Registry v1 is the tool-selection boundary underneath Capability Planner.

## Product rule

**Recipes name stable creative capabilities. Adapters are swappable implementations of those capabilities.**

The artist and the Partner do not choose model names, engines, node graphs, endpoints or vendors. Capability Planner asks the registry whether a suitable adapter actually exists; only the registry may upgrade an adapter-driven capability from its fallback state.

## Descriptor and execution boundary

Adapters declare data-only descriptors:

- stable adapter ID and capability ID;
- availability (`available | degraded | disabled`);
- invocation boundary (`server | surface | external`);
- deterministic priority;
- creative-mutation and mandatory-review flags;
- required evidence;
- input/output contracts;
- preservation guarantees and side effects;
- a private implementation reference that is never exposed through public descriptors or Partner plans.

Any adapter with `creativeMutation=true` must also declare `reviewRequired=true`.

The registry exposes `getImplementationRef()` only for bounded server-side bridges. Public `get`, `list`, `resolve`, Partner execution plans and invocation requests omit the implementation pointer.

## Deterministic resolution

Resolution excludes disabled adapters, accepts available adapters (and degraded adapters when allowed), sorts by descending priority, then breaks ties by adapter ID. Missing production adapters leave capabilities honestly `planning_only` or `unavailable`.

## Registered adapters

### `bounded_image_region_v1`

The existing reviewable local image-edit path:

- capability: `local_image_take`;
- boundary: `surface`;
- evidence: exact shot scope + edit region;
- input: shot/base revision, region PNG, mask PNG, prompt;
- output: immutable candidate take;
- accepted artwork remains unchanged until an explicit review/commit action.

### `animatic_timing_v1`

The video-skill static-panel animatic adapter is registered only when the complete runtime is explicitly configured and validated:

- `RAINDESK_ANIMATIC_EXECUTOR`: absolute executable file;
- `RAINDESK_ANIMATIC_PROJECT_ROOT`: absolute writable/executable project directory;
- `RAINDESK_SOURCE_RIGHTS`: server-owned source-rights assertion;
- optional bounded execution timeout.

The adapter contract is:

- capability: `animatic_timing`;
- boundary: `external`;
- creative mutation: yes;
- review required: yes;
- input: `SequenceSourceSnapshot@0.2.0` bound to `animatic_timing_v1` / contract `0.2.0`;
- output: `ExecutionAttempt@0.2.0`, `SequenceCandidateManifest@0.2.0`, immutable MP4 artifact;
- accepted artwork and review state remain outside the candidate manifest.

Without complete runtime configuration, `animatic_pass` remains `planning_only`.

## Current animatic vertical slice

The branch now contains more than registration. The bounded path currently includes:

1. a coarse server-minted Partner invocation;
2. server-owned artwork revision binding;
3. immutable pacing proposals whose creative timing is model-suggested but whose source revisions are server-resolved;
4. exact `SequenceSourceSnapshot@0.2.0` compilation with content-addressed panel projection;
5. a separately approved server-prepared child invocation bound to the snapshot digest;
6. no-shell external execution with bounded stdio/timeout;
7. validation and import of external attempt/candidate records;
8. SHA-backed Raindesk MP4 mirroring and Range serving;
9. an append-only ReviewDecision log — owner decisions as events about immutable candidates, surfaced through the owner-visible review UI.

Frames plus rational frame rate are the timing authority. Pacing proposals and snapshots share one validation envelope (`lib/animatic-contract.js`) so proposal content cannot be accepted under looser limits than the snapshot compiler.

## Vertical-loop status (2026-08-20 closeout)

The artist-facing vertical loop is complete and browser-proven:

- Preparation is **stored-proposal-only**: `/api/animatic/prepare` and Preview accept exactly one immutable proposal digest; the server derives order, revisions and durations internally. The reviewer-facing browser API (`public/js/animatic-api.js`) exposes digest reads, Preview, execution polling, candidate listing and review only — context/proposal creation stay behind the server-side Partner boundary, and raw prepare/execute are no longer browser powers.
- Pacing proposals render as reviewer-first Partner cards with Preview this; preview is asynchronous (202 + durable execution row, polled, reload-reconnect).
- Imported candidates surface as playable Animatic Takes (real MP4 playback proof: metadata, seek) with `Keep / Another / Reject`; `Combine` stays visibly disabled until immutable candidate-bound ReviewAnnotation evidence exists — it records no intent meanwhile.
- ReviewDecision is wired through the owner-visible UI with append-only decisions and server-owned `actor_role=owner`.
- A real owner-host proof against the pinned video-skill executor passed locally (sanitized receipt; see `dev/browser-animatic-real-host-proof.js`).

Honest remaining limitations:

- The Takes list is not yet scoped to the active shot/sequence (global recent list).
- Restored take cards show a generic label, not the source proposal's rhythm name; the server-side provenance summary is future work.
- `Another` records the request and tells the artist, but does not yet guarantee a meaningfully different rhythm (structured open loop is future work).
- A direction-note edit after preview makes proposal reconnect fail-safe 404 (the creative-state digest drifts); the durable execution row remains reachable by id.

## Still-unregistered production capabilities

No production adapters are registered yet for camera previs, pose/blocking, performance motion, contact geometry, multi-actor blocking, environment construction, comic layout or automatic visual inspection.

Those remain `planning_only`/`unavailable`. Broad Editorial / Composition / Motion / Audio IR work stays deferred until the Raindesk animatic loop proves the shared authority/review pattern end to end.
