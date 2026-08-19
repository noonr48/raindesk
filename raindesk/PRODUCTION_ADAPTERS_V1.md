# Raindesk Production Adapter Registry v1

Production Adapter Registry v1 is the tool-selection boundary underneath Capability Planner.

## Product rule

**Recipes name stable creative capabilities. Adapters are swappable implementations of those capabilities.**

The artist and the Partner do not choose model names, engines, node graphs, endpoints or vendors. Capability Planner asks the registry whether a suitable adapter actually exists; only the registry may upgrade an adapter-driven capability from its fallback state.

## Why descriptor-first

V1 registers data-only adapter descriptors rather than arbitrary executable callbacks. Before execution is allowed, each adapter must declare:

- stable adapter ID;
- stable capability ID;
- availability (`available`, `degraded`, `disabled`);
- invocation boundary (`server`, `surface`, `external`);
- priority for deterministic selection;
- whether it mutates creative content;
- whether review is mandatory;
- required evidence;
- input/output contract;
- preservation guarantees;
- side effects;
- private implementation reference.

This lets Raindesk compare and route adapters without letting tool-specific details leak upward into recipes.

## Safety invariant

Any adapter declaring `creativeMutation=true` must also declare `reviewRequired=true`.

Registration rejects descriptors that violate this invariant. Act mode therefore cannot gain an auto-accepting creative adapter by configuration accident.

## Deterministic resolution

A registry may contain multiple adapters for one capability. Resolution:

1. excludes disabled adapters;
2. accepts available adapters and, by default, degraded adapters;
3. sorts by descending priority;
4. breaks equal priority deterministically by adapter ID.

Candidate selection is therefore reproducible and testable.

## Capability Planner composition

The previous Capability Planner is preserved byte-for-byte as `capability-planner-core.js`.

The new `capability-planner.js` façade treats specialist production capabilities as adapter-driven:

- if a suitable adapter resolves, adapter review requirements determine `operational` vs `review_take`;
- if no adapter resolves, the capability falls back to `planning_only` (or `unavailable` for visual inspection);
- adapter evidence requirements are unioned with recipe evidence requirements;
- surface/external adapters are not mislabeled as server executors;
- private `implementationRef` values are never copied into the Partner `executionPlan`.

The registry also exposes a deliberately server-internal `getImplementationRef()` accessor. It exists for bounded executor bridges; public `get`, `list`, `resolve`, Partner plans and invocation requests still omit the private implementation pointer.

## Registered adapters

### `bounded_image_region_v1`

The existing bounded image-generation route:

- capability: `local_image_take`;
- availability: `available`;
- invocation boundary: `surface`;
- creative mutation: yes;
- review required: yes;
- evidence: shot scope + explicit edit region;
- inputs include shot/base revision, region PNG, mask PNG and prompt;
- output is an immutable candidate take;
- accepted artwork remains unchanged until commit.

### `animatic_timing_v1` — explicit configuration only

Raindesk now has a registration seam for the video-skill slice-C animatic executor. It is **not** registered merely because the recipe exists. The owner/operator must explicitly set `RAINDESK_ANIMATIC_EXECUTOR` when constructing the default registry.

When configured, the descriptor declares:

- capability: `animatic_timing`;
- invocation boundary: `external`;
- creative mutation: yes;
- review required: yes;
- input authority: `SequenceSourceSnapshot@0.2.0` targeting `animatic_timing_v1` / contract `0.2.0`;
- outputs: `ExecutionAttempt@0.2.0`, `SequenceCandidateManifest@0.2.0`, and animatic media;
- accepted artwork remains untouched and review state remains outside the immutable candidate manifest.

Without that explicit configuration, `animatic_pass` remains honestly `planning_only`.

This slice registers capability truth and the private hand-off seam only. It does **not** yet construct the snapshot, spawn the executor, mirror its outputs, or show a playable candidate in the desk.

## Still-unregistered production capabilities

No adapters are registered yet for:

- camera previs;
- pose/blocking;
- performance motion;
- contact geometry;
- multi-actor blocking;
- environment construction;
- comic layout;
- automatic visual inspection.

Those capabilities therefore remain honestly `planning_only`/`unavailable` until a later slice registers a real adapter.

## Scope

V1 still does not execute arbitrary adapter callbacks. The next animatic slice should bind the configured external implementation to a bounded snapshot compiler/invoker while retaining the same capability IDs, evidence gates, review policy and deterministic selection rules.
