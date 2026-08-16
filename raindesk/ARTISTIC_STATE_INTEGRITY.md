# Raindesk — Artistic State Integrity Contract

This branch hardens the substrate underneath the Direction Partner work. The product rule is simple:

> **An artist may explore aggressively because accepted work, raw direction, and editable state are never silently flattened, overwritten, or lost.**

The artist still works with sketches, arrows, short movement descriptions and casual Partner conversation. These systems exist underneath so the surface can remain loose.

## 1. Creative source-of-truth hierarchy

1. **Artist raw mark / wording** — authoritative creative source.
2. **Partner interpretation** — provisional enrichment; never replaces the raw source.
3. **Workflow plan** — derived production plan.
4. **Tool output** — candidate take.
5. **Accepted take** — project decision represented by a new immutable artwork revision.

No lower level silently rewrites a higher level.

## 2. Editable shot documents

The canonical artwork state is no longer a flattened preview PNG.

Each shot has immutable `ShotDocument` revisions containing:
- canvas size;
- ordered typed layers;
- active layer;
- vector stroke data for pen/vector layers;
- SHA-256 references for raster/base/generated layers;
- generated-layer provenance (`sourceTakeId`).

Raster bytes live in the immutable content-addressed blob store. A save creates a new revision with a parent revision. Optimistic concurrency rejects stale overwrites with HTTP 409. Restoring an older revision creates another new revision; history is never rewritten.

### Layer contract

- `pen` / `vector`: replayable strokes, **no raster blob reference**.
- `base` / `raster` / `gen` / `temp`: immutable raster blob reference, **not rebuilt from strokes**.
- accepted generation is a separate `gen` layer.

This fixes the destructive sequence that originally motivated the branch:

`accept generated take → draw pen stroke → undo pen stroke`

The accepted raster remains byte-identical.

## 3. Generated takes are durable candidates

A generation is not considered complete until Raindesk has mirrored the output into the immutable blob store.

Every candidate records:
- shot and job ID;
- exact source artwork revision;
- exact source crop blob;
- exact mask blob;
- result blob;
- prompt / negative / seed;
- lasso / region geometry;
- lifecycle (`candidate`, `accepted`, `rejected`, `superseded`).

Acceptance is recorded only after the editable shot revision containing the new generated layer is safely saved. Undoing that accepted layer reopens the take as a candidate after the undo revision is safe.

The Partner drawer reads server-side take history first. localStorage remains only as a legacy/offline fallback.

## 4. Durable directing semantics

Direction Graph schema v2 uses the same storyboard shot IDs as the artwork store. Legacy `legacy_Sxx` bridge IDs migrate idempotently to `Sxx` where safe.

A Beat may stay simple, or carry lightweight event relationships for complex direction:
- action;
- performance;
- dialogue;
- camera;
- contact;
- sound.

Relations include `before`, `after`, `during`, `overlaps`, `follows`, `causes`, and `simultaneous`.

Raw wording remains attached to every interpretation.

Camera path endpoints are **camera cues**, not fake start/end frames. True start/landing frames require an explicit visual reference.

## 5. Partner safety contract

The model does not directly mutate the project.

- **Watch**: semantic project state is read-only; conversation may still be remembered.
- **Suggest**: creates proposals requiring approval.
- **Act**: only a small whitelist of reversible spatial workspace actions may be pre-approved. Content-destructive actions remain proposals.

Partner actions have a durable lifecycle and inverse receipt so accepted workspace moves can be reverted.

Recent Partner conversation is stored separately from semantic Direction memory. This lets one-shot Pi calls understand follow-ups such as “use the second one, but only its expression” without making Watch mode mutate creative state.

The full creative prompt is sent to Pi through stdin rather than the process argument list.

## 6. Workspace substrate

The future endless desk is represented independently of final styling.

Persistent workspace objects have:
- stable object ID and entity reference;
- x/y, width/height, scale, rotation, z-index;
- visible/collapsed/locked state;
- dock and group identity.

This is the substrate for detachable character canvases, PureRef-like reference boards, floating Beat Trails, scene strips and later paper/sketchbook styling.

## 7. Long-running work / anti-freeze

Generation jobs persist status and human-readable phase:

`queued → generating → mirroring → complete`

Queued work can be genuinely cancelled. Once GPU work is running, Raindesk explicitly refuses to pretend it has cancelled something the current adapter cannot stop.

Completed job receipts persist image blob SHA and take ID, so a browser can reconnect after a server restart and recover the result.

## 8. Network safety

Default bind is `127.0.0.1`.

Remote binding requires a `RAINDESK_REMOTE_TOKEN` of at least 24 characters. Remote browser access uses an HttpOnly SameSite cookie after an unlock screen; API clients may use `Authorization: Bearer <token>`.

Wildcard binds (`0.0.0.0` / `::`) are refused unless `RAINDESK_ALLOW_WILDCARD=1` is also explicitly set. Prefer a specific trusted/Tailscale interface.

## 9. Unsynced work

The UI marks a shot unsynced before deferred persistence begins. Failed snapshots remain in memory for retry, and Raindesk refuses to switch away from a shot whose current edit has not synced safely. `beforeunload` warns about unsynced work.

A future slice should add an IndexedDB outbox and an explicit conflict-resolution surface. This branch intentionally does **not** claim that in-memory recovery is crash-proof.

## 10. Validation gates

The integrity branch must pass:
- complete Node test suite;
- the concrete generation/pen undo regression;
- immutable revision / stale-write / restore tests;
- take provenance and lifecycle tests;
- permission enforcement tests;
- generation restart receipt tests;
- remote auth/bind tests;
- Chromium boot marker check;
- dependency-free browser persistence smoke when Chromium policy permits it.

The browser smoke performs a real edit/reload/edit/undo cycle and verifies the server-side editable vector state, rather than merely checking source strings.

## Explicit non-goals of this branch

This branch does **not** finish:
- the warm paper/sketchbook visual redesign;
- the endless-canvas DOM/SVG renderer;
- full UI conflict resolution;
- IndexedDB offline outbox;
- arbitrary Partner execution of production tools;
- motion/video adapters;
- multi-project database migration.

Those should build on this substrate rather than bypass it.
