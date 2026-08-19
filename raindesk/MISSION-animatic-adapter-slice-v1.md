# Mission — Animatic Adapter Slice v1

## Question

Can Raindesk truthfully recognize the existing video-skill animatic executor as a production capability **only when the owner explicitly configures that executor**, while preserving the review-first authority model?

## Baseline

Main at `0fd4d1da4a4b6f21893e7ac305f6d4c739ce629e` already has:

- `animatic_pass` -> `animatic_timing` in Capability Planner;
- descriptor-first Production Adapter Registry;
- bounded adapter invocation requests;
- no registered animatic adapter, so animatic work correctly remains `planning_only`.

The companion video stack's slice-C executor accepts a `SequenceSourceSnapshot` contract v0.2 and identifies itself as `animatic_timing_v1`. This mission adds the Raindesk registration seam; it does **not** claim the end-to-end renderer bridge is complete.

## Acceptance criteria

1. Without explicit configuration, the default registry still has no animatic adapter and `animatic_pass` remains `planning_only`.
2. With `RAINDESK_ANIMATIC_EXECUTOR` explicitly configured, a registry can register `animatic_timing_v1` for capability `animatic_timing`.
3. The descriptor declares external invocation, `SequenceSourceSnapshot@0.2.0` input, candidate/attempt outputs, and mandatory artist review.
4. Act mode cannot auto-accept or auto-commit animatic output; the planner disposition remains `proposal`.
5. The private implementation reference is never present in Partner/public descriptor projections, but server-side code has an explicit accessor for a later bounded executor bridge.
6. Existing bounded-image registration behavior is unchanged.
7. Deterministic tests cover unconfigured fail-closed behavior, configured registration, planning upgrade, review gating, and implementation-ref privacy.

## Explicit non-goals

- constructing `SequenceSourceSnapshot` from Raindesk artwork/beat state;
- spawning the Python executor;
- mirroring returned MP4/manifest artifacts into Raindesk storage;
- owner-visible video preview / Keep / Another / Combine / Reject UI;
- visual-observer interpretation of raw sketches.

Those are subsequent slices. This slice establishes capability truth and the private hand-off seam without pretending execution already exists.
