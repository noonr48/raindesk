# Mission — Reviewable Pacing Vertical Slice v1

Baseline: verified branch checkpoint `162bc51b6184a52a3c8ab7b2f8bf39d231bb9d0a` on `chatgpt/animatic-adapter-slice-v1`.

## Goal

Close the first artist-facing Raindesk → video-skill loop instead of adding more horizontal infrastructure.

The artist should be able to speak/direct normally, see one or more understandable pacing interpretations, choose **Preview this**, watch the resulting rough animatic inside Raindesk, then react with **Keep / Another / Reject**. `Combine` must stay visibly unavailable until Raindesk has real candidate-bound ReviewAnnotation evidence; it must never be faked with mutable Direction Graph annotation ids.

## Product rule

**Raindesk owns creative/project/source authority. The Partner proposes rhythm. The video skill produces immutable evidence. The artist's explicit review decision is the only acceptance authority.**

No default UI exposes revision ids, snapshot digests, paths, adapter ids, schema names, worker commands or frame-accounting machinery.

## Hard acceptance gates

1. The complete deterministic suite is green at the exact final SHA after every mutation group.
2. The pacing/snapshot contract stays one shared validation envelope.
3. Browser preparation accepts only an immutable stored proposal digest; replacement shot order, duration and artwork revision data cannot be posted at prepare time.
4. A server-owned pacing context binds project id, sequence id, rational frame rate, eligible shot ids, exact artwork revisions and creative-state digests before the Partner creates timing advice.
5. Partner/model input may propose only label, rationale, ordered shot ids, durations and notes. It cannot choose project id, sequence id, frame rate, artwork revision, path, rights, adapter, snapshot or approval state.
6. Proposal freshness checks both artwork revision and the bounded creative-state digest the Partner reasoned over.
7. Clicking **Preview this** means approval of that exact immutable proposal. The browser does not need to understand or manufacture a production request.
8. External execution remains review-only and can never accept a candidate.
9. Imported candidates are listed through a Raindesk-owned API with derived review state and only same-origin SHA-backed MP4 URLs.
10. Keep / Another / Reject append server-owned `ReviewDecision@0.2.0` events; candidate manifests remain byte-semantically immutable.
11. `Another` records review intent only. It does not silently rerun the same snapshot.
12. `Combine` is disabled with an honest explanation until immutable candidate-bound review annotations exist.
13. Reload restores pacing proposals, execution/candidate state and derived review state from server data.
14. A native browser smoke proves proposal → preview → playable take → review → reload using a bounded fake executor. A separate owner-host proof against the real pinned video skill remains the final merge gate.

## Pacing context contract

`AnimaticPacingContext v1` is immutable and content-addressed. It contains:

- server-owned project id;
- server-minted sequence id for the active scene/shot scope;
- rational frame rate;
- source Partner invocation id/turn id;
- ordered eligible shot summaries;
- per shot: shot id, exact current artwork revision id, bounded creative-state digest and short human-facing title/beat summary;
- context digest.

The context does not contain panel paths, raw pixels, source-rights claims, worker configuration or approval state.

## First UX

A pacing offer should read approximately:

> **Restrained**
> Wide descent 3.2 s → hold on Lena 1.5 s → wheel slip 0.7 s
>
> [Preview this]

After production:

> **Animatic take** · 5.4 s
> [video]
> [Keep] [Another] [Reject] [Combine — add review notes first]

The primary interaction is rhythm and reaction. Frames/hashes remain advanced provenance only.

## Non-goals

- no Visual Observer in this slice;
- no broad Editorial/Composition/Motion/Audio IR;
- no NLE timeline editor;
- no autonomous acceptance;
- no high-fidelity motion generation;
- no fake Combine implementation;
- no second production adapter family.
