# Raindesk Capability Planner v1

Capability Planner v1 is the connective layer between creative intent and production tooling.

## Product rule

**A workflow recipe describes what the artist wants to accomplish. It does not prove that Raindesk has an adapter capable of producing it.**

The Partner remains the single artist-facing collaborator. Internally, after a Partner turn has been interpreted and routed to stable recipes, the deterministic Capability Planner resolves those recipes against an explicit capability registry.

The artist is never asked to choose model names, node graphs, or technical adapters.

## Three independent questions

Every planned stage keeps three questions separate:

1. **Capability:** can Raindesk perform this class of work at all?
2. **Evidence:** are the required shot/region/frame/character inputs actually present?
3. **Permission:** even if available and ready, may the Partner act automatically, only propose it, or only discuss it?

None of these dimensions can upgrade another.

## Capability states

Every capability is classified as one of four states:

- `operational` — a bounded Raindesk capability is wired now;
- `review_take` — a production path exists, but its output is a reversible candidate that requires artist review;
- `planning_only` — Raindesk can structure/prepare the work, but the specialist production adapter does not exist yet;
- `unavailable` — the capability is absent and must not be implied.

## Permission dispositions

The planner derives a separate disposition for each stage:

- `auto` — only explicitly safe preparation/organization in Act mode;
- `proposal` — available work that still requires review/approval;
- `advisory` — Watch mode; capability truth is visible but nothing proceeds;
- `blocked` — missing evidence or missing production capability.

Permission mode (`watch` / `suggest` / `act`) never upgrades capability state. In particular:

- Watch mode cannot execute an otherwise available capability;
- Suggest mode produces proposals;
- Act mode cannot turn `review_take` into an automatic content edit;
- Act mode cannot turn `planning_only` into a real executor.

## Evidence gates

Execution planning fails closed on production evidence. Current gates include:

- actual shot scope;
- explicit bounded image-edit region;
- visual start/end frame references;
- character presence;
- multiple-character presence for contact/choreography.

A scene ID is not accepted as a shot scope. A direction annotation or arbitrary selected object is not accepted as an image-edit region.

Missing evidence remains visible in `blockedBy` even when a downstream adapter is also missing, so future adapter work does not accidentally erase the input contract.

## Current capability reality

Operational preparation/review infrastructure includes:

- Direction Graph intent/beat structure;
- reversible workspace arrangement;
- immutable reference/sheet evidence;
- explicit Character identity authority;
- candidate-take lifecycle.

Bounded local image generation is classified `review_take`: it can create a candidate inside an explicit region, but acceptance remains an artist decision.

The following remain `planning_only` in v1 rather than being overclaimed from recipe names:

- camera previs;
- controllable pose/blocking;
- facial/performance motion;
- contact/body geometry;
- multi-actor blocking;
- environment construction beyond bounded image editing;
- comic layout;
- animatic timing/assembly.

Automatic raw-pixel reference inspection is explicitly `unavailable`; immutable image SHAs remain asset references, not proof that the Partner visually inspected them.

## Partner contract

Every completed structured Partner turn now includes an internal `executionPlan` containing:

- selected recipe IDs;
- capability stages;
- capability and effective stage state;
- required/missing evidence;
- permission disposition;
- executor identity when one actually exists;
- review requirement;
- available stages;
- auto-executable safe stages;
- reviewable stages;
- blockers.

The model does not author this plan. It may suggest workflow recipe IDs, but the deterministic planner owns capability and permission truth.

## Scope

Capability Planner v1 intentionally does **not** add production pose/camera/motion adapters. It establishes the contract those adapters must satisfy before they can be presented to the Partner as real capabilities.
