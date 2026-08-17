# Raindesk Surface Hand-off v1

Surface Hand-off v1 is the first artist-facing consumer of bounded adapter invocation requests.

## Product rule

**Partner approval may prepare an existing creative surface. It does not secretly execute the creative operation.**

For the current `bounded_image_region_v1` adapter, the existing lasso / prompt / GEN / take / COMMIT flow remains the only generation path.

## Interaction

When a Partner turn contains a supported `awaiting_approval` surface request, the Partner drawer shows a small proposal:

- `set up GEN`
- `not now`

Choosing `set up GEN`:

1. verifies the request still belongs to the active shot;
2. highlights the existing GEN bar;
3. focuses the existing prompt field;
4. leaves any existing prompt untouched;
5. tells the artist to check the visible lasso and press GEN when ready.

It does **not** click GEN, submit an API request, commit a take, or alter the canvas.

## Stale-context behavior

Invocation Requests now carry an approval-time scope snapshot:

- shot ID;
- art revision ID when available;
- deterministic selection fingerprint.

The Surface Hand-off v1 UI immediately enforces shot identity. If the artist has moved to another shot, the proposal becomes stale and refuses to prepare GEN.

Selection/revision fingerprints are retained for stronger later executor verification. In v1 the final explicit GEN click remains a separate user action against the live visible lasso and artwork, so the hand-off never executes against hidden stale geometry.

## Load-time composition

`public/js/surface-handoff.js` loads after `chat.js` and before `app.js`.

It wraps `RaindeskChat.ChatDrawer` before the application constructs the drawer. The wrapped drawer listens to completed Partner turns and renders supported surface proposals. This avoids rewriting the large established `app.js` generation implementation or introducing a second generation path.

## Supported adapter

V1 supports exactly:

- adapter: `bounded_image_region_v1`;
- capability: `local_image_take`;
- invocation boundary: `surface`;
- request state: `awaiting_approval`;
- disposition: `proposal`;
- creative mutation: true;
- review required: true.

Other adapters and request states are ignored rather than guessed.

## Scope

Surface Hand-off v1 does not:

- approve server-side action ledgers;
- auto-run GEN;
- auto-fill model prompts from Partner prose;
- validate current lasso fingerprint at execution time;
- accept/commit generated output;
- service server or external adapter boundaries.

The next refinement should add a small persistent invocation/approval ledger so proposal approval, cancellation, preparation and eventual take provenance can be audited across reloads without coupling the UI to model internals.
