# Mission — Animatic Preparation v1

Baseline: `chatgpt/animatic-adapter-slice-v1` after invocation-authority v2.

## Problem

An `animatic_timing_v1` capability request says the artist is interested in a timing preview, but it does **not** yet authorize a particular ordered sequence, frame duration plan, or source snapshot. Executing directly from that coarse request would let preparation silently broaden creative authority.

## Product rule

**The Partner may propose an animatic; execution may run only after the artist approves the exact immutable snapshot that will be handed off.**

## Acceptance criteria

1. Every actionable Partner invocation request is durably recorded server-side as a `proposed` v2 invocation before it is exposed as an approval affordance. The browser may present an invocation; it may not mint one.
2. If proposal persistence fails, the creative conversation may continue but actionable invocation requests are withheld rather than becoming unverifiable browser-only authority.
3. Invocation v2 adds immutable `parentRequestId` and `sourceSnapshotDigest` bindings. Existing v1/v2 rows migrate/read with those fields absent; a bound digest cannot be changed by replay.
4. Animatic preparation looks up the parent request by id from the server ledger and requires `adapterId=animatic_timing_v1`, `capabilityId=animatic_timing`, `invocationBoundary=external`, `disposition=proposal`, and mandatory review/creative-mutation flags. Browser copies of those claims are ignored.
5. Preparation compiles a new `SequenceSourceSnapshot@0.2.0` using server-owned ShotDocument projection and a server-configured source-rights assertion. The browser never supplies or upgrades the rights assertion.
6. The parent request's active shot must appear in the prepared sequence, but preparation may contain multiple explicitly ordered shots because the resulting child proposal receives a **new deterministic id bound to the complete snapshot digest**.
7. The prepared child invocation is stored as `proposed`, references its parent request, carries the exact `sourceSnapshotDigest`, and cannot be executed until separately approved.
8. Re-preparing the same parent + same snapshot is idempotent. Different timing/order/source state produces a different child proposal id.
9. Surface approval records full bounded authority and transitions lifecycle through PATCH; POST replay alone never upgrades status.
10. Tests cover server-side proposal recording, browser-forgery refusal, rights sourcing, deterministic child ids, digest immutability, and separate approval requirement.

## Non-goals

- No external process launch in this mission.
- No MP4 import or playback yet.
- No automatic timing inference yet; ordered shots and durations remain explicit proposal inputs.
- No candidate acceptance state is stored on the candidate. ReviewDecision remains the later acceptance authority.

## Follow-on gate

The execution mission may accept only an **approved prepared child invocation** whose `sourceSnapshotDigest` resolves to an integrity-verified Raindesk snapshot and whose configured executor is an absolute no-shell executable path.
