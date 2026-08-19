# Mission — Animatic Pacing Proposals v1

Baseline: `chatgpt/animatic-adapter-slice-v1` after the immutable snapshot / invocation-authority / external animatic slices.

## Why this slice exists

Raindesk can now represent an animatic capability, bind work to an immutable `SequenceSourceSnapshot@0.2.0`, and hand a reviewed snapshot to the external `animatic_timing_v1` worker. The remaining product gap is upstream: an artist should not have to manufacture ordered shot ids and frame counts by hand.

The Partner should be able to look at the Direction Graph, Beat Trail, pinned references and later visual-observer evidence and propose a concrete pacing interpretation such as:

> wide descent — 78 frames → Lena hold — 34 frames → wheel slip — 17 frames

That proposal is **creative advice**, not execution authority. The artist must be able to understand exactly what timing is being proposed before any snapshot or worker run is approved.

## Product rule

**The agent may propose timing. The server owns source identity. The artist approves an explicit pacing proposal. Only then may Raindesk compile the exact immutable execution snapshot.**

No model-authored revision id, filesystem path, rights assertion, snapshot digest, adapter identity, execution id or candidate id is trusted.

## Proposal contract

`AnimaticPacingProposal v1` is a Raindesk-local, closed-world document. It contains only creative/editorial material and server-resolved source bindings:

- stable proposal id and canonical proposal digest;
- source Partner turn id and parent animatic invocation id;
- project / sequence identity;
- frame rate and fidelity (`draft | preview`);
- short label + rationale;
- an ordered list of shot items;
- per shot: stable shot id, **server-resolved artwork revision id**, explicit `duration_frames`, and an optional bounded creative note;
- total frame count / duration derived by the server;
- created-at timestamp;
- lifecycle `proposed | stale | prepared | declined`.

The document does **not** contain panel paths, raw PNG bytes, source-rights claims, external executor configuration, approval state for a generated candidate, or a `SequenceSourceSnapshot` digest.

## Acceptance criteria

1. Proposal input from the Partner is closed-world and bounded: at most 256 shots; no duplicate shot ids; positive integer duration per shot; bounded labels/notes; sane frame-rate bounds; supported fidelity only.
2. The parent invocation is looked up from the server ledger and must be a live `origin=partner_server` `animatic_timing_v1` proposal. The browser/model cannot provide a replacement adapter/capability/permission claim.
3. The parent invocation's active shot must appear in the proposed sequence and must bind to the exact artwork revision frozen by the parent invocation.
4. Every other proposed shot id is resolved through the server-side ShotDocument store. The Partner supplies shot ids and creative timing only; the server supplies revision ids.
5. Proposal creation fails closed if any referenced shot lacks a readable persisted artwork revision. It never substitutes the current canvas DOM or an external path.
6. Stored proposal identity is deterministic over canonical creative content + resolved revisions + parent request. Repeating the same Partner proposal is idempotent; changing order, duration, fidelity, notes or source revision creates a different proposal identity.
7. The public proposal projection contains enough information to review timing (`frames`, derived seconds, notes, ordered shots) but contains no local paths or executor details.
8. Proposal freshness is derived against the current ShotDocument revisions. A source edit after proposal creation marks the proposal stale for presentation; stale does not delete the proposal or rewrite its historical bindings.
9. Preparing an animatic uses only the stored proposal document. The browser may name a proposal id; it may not POST a replacement shot list or revision ids at prepare time.
10. Preparation feeds the proposal's exact stored order/revisions/durations into the existing `animatic-preparation` boundary. Source rights remain server-configured and the resulting child invocation remains review-gated under the existing authority contract.
11. Declining a proposal is durable and reversible only by creating another proposal; declined documents are never silently reused for execution.
12. No execution is triggered by proposal creation. No candidate is accepted by proposal approval/preparation.
13. Tests cover malformed/duplicate shots, model-forged revisions ignored, parent-shot mismatch, missing persisted art, deterministic proposal ids, source-edit staleness, path redaction, exact preparation hand-off and no-execution side effects.

## Partner-facing behavior

The Partner should talk in directing language, not frame-accounting language unless the artist asks for it. A proposal can be presented as:

- **Restrained:** establish 3.2 s → Lena 1.5 s → slip 0.7 s
- **Tighter:** establish 2.1 s → Lena 0.8 s → slip 0.5 s

Frame counts remain visible as technical detail, but the primary interaction is comparing how the rhythm feels.

The Partner may propose more than one interpretation, but each interpretation is a distinct immutable proposal. There is never one mutable "AI timing" object whose meaning changes underneath an approval.

## Visual-observer follow-on

This slice must not pretend the Partner can already read raw sketch pixels. Later, a Visual Observer may add structured evidence from clean artwork / markup / reference channels. That evidence can inform proposal generation, but it cannot bypass this same proposal → source binding → artist review → snapshot authority chain.

## Non-goals

- No automatic visual interpretation in this slice.
- No automatic `Keep` decision.
- No broad NLE timeline editor.
- No hidden model-chosen shot revisions.
- No silent worker reruns when the artist asks for "Another".
- No high-fidelity motion generation; this remains the static-panel animatic vertical slice.
