# Mission — Invocation Authority Hardening v2

Baseline: `chatgpt/animatic-adapter-slice-v1` at `211d8a6390c899c55578dd0cd9d876a7d24f8da4`.

## Why this must precede external execution

The current Partner invocation request contains a frozen creative scope, but the durable approval ledger stores only shot/adapter/capability identity. After a reload it reconstructs a weaker request and loses the exact artwork revision and selection that were approved. That is acceptable only while the hand-off is a convenience UI; it is not strong enough to authorize an external video executor.

## Product rule

**Approval authorizes one bounded request against one frozen creative scope. Reloading, retrying, or handing the request to another process must never broaden that authority.**

## Acceptance criteria

1. Invocation ledger schema v2 durably stores the bounded immutable request facts needed to re-establish authority: adapter/capability, boundary, review/mutation flags, recipe/stage identity, frozen scope, required inputs, expected outputs, preservation guarantees and side effects.
2. Existing schema-v1 ledgers migrate without losing their historical status. Old entries that never recorded a frozen scope remain readable but cannot magically gain one.
3. Re-recording the same invocation id with the same immutable request is idempotent. Reusing an existing id for materially different immutable request content fails with conflict instead of silently returning the older row.
4. Supersession is scoped by **shot + adapter**. Approving an animatic request must not stale an unrelated bounded-image request for the same shot (or vice versa).
5. The composed Partner server overwrites browser-reported `artRevisionId` with the authoritative current ShotDocument revision for the active shot before Capability Planner / invocation creation. Browser context may select a shot; it may not assert the persisted revision.
6. Surface hand-off approval POSTs the exact bounded request facts to the ledger. Reload restore uses the stored frozen scope rather than synthesizing `{shotId}` only.
7. Client stale checks fail closed: if an approved request froze an artwork revision or selection and the live surface cannot prove the same revision/selection, the request is stale and cannot be prepared.
8. Existing bounded image generation remains review-gated and otherwise behavior-compatible.
9. No external executor is launched by this mission; this is authority hardening only.
10. Tests cover v1→v2 migration, exact-scope persistence, conflicting duplicate ids, adapter-scoped supersession, server-authoritative revision override, reload scope restoration shape, and fail-closed stale comparison.

## Follow-on gate

The first animatic execution route may only accept an **approved v2 invocation** and must bind that invocation to one immutable `SequenceSourceSnapshot.snapshot_digest` before process hand-off.
