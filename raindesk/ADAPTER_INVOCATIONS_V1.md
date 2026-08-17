# Raindesk Adapter Invocation Requests v1

Adapter Invocation Requests v1 is the hand-off boundary between a validated Partner execution plan and the system surface that can actually perform the work.

## Product rule

**A request describes bounded work. It is not arbitrary code execution and it is not acceptance of the result.**

The existing Partner remains artist-facing. Internally:

`artist intent → Partner interpretation → recipe → capability plan → adapter selection → invocation request`

V1 stops at the request. The correct boundary can consume it later.

## Request eligibility

An invocation request is emitted only when all of the following are true:

- the execution-plan stage is `operational` or `review_take`;
- the stage disposition is `proposal` or `auto`;
- a concrete adapter ID is present;
- the adapter still exists in the trusted registry;
- its capability matches the stage capability;
- it is not disabled;
- required evidence is complete;
- a creative-mutating adapter is still review-required.

Watch mode always emits zero actionable requests.

`planning_only`, `unavailable`, `needs_evidence`, `blocked` and `advisory` stages emit zero requests.

## Stable request identity

Request IDs are deterministic from:

`turnId + stageId`

This lets a later executor or UI surface deduplicate retries rather than creating duplicate work when the same hand-off is replayed.

## Request contents

A request contains only the bounded contract needed for hand-off:

- turn/stage/recipe/capability IDs;
- adapter ID;
- invocation boundary;
- permission disposition;
- request status;
- review/mutation flags;
- required evidence;
- adapter input contract;
- expected output contract;
- preservation guarantees;
- declared side effects.

The adapter registry's private `implementationRef` is deliberately excluded.

## Boundary states

Current request statuses:

- `awaiting_approval` — a proposal exists but the artist/permission flow has not approved it;
- `awaiting_surface` — an approved/auto surface-bound request is ready for UI-level fulfillment;
- `ready_server` — an approved/auto server-bound request may be handled by a later bounded server executor;
- `awaiting_external` — an approved/auto request targets a later external connector/tool boundary.

Creative adapters currently remain proposals, so the existing local image adapter normally yields `awaiting_approval`, not automatic generation.

## Partner composition

The previous Partner implementation is preserved byte-for-byte as `partner-plan-core.js`.

The new `partner.js` façade calls the existing turn, then derives `invocationRequests` solely from the completed deterministic `executionPlan`.

The model does not author request fields and cannot provide an implementation reference.

## Scope

V1 does not:

- invoke server callbacks;
- click UI controls;
- call external connectors;
- approve a proposal;
- accept or commit a generated take;
- permit arbitrary adapter code.

The next execution work can bind specific request statuses to bounded handlers while preserving the same request IDs, evidence gates, adapter contracts and review policy.
