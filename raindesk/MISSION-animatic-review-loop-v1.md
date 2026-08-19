# Mission — Animatic Review Loop v1

Baseline: `chatgpt/animatic-adapter-slice-v1` after the bounded animatic execution/import slice.

## Goal

Turn imported `SequenceCandidateManifest@0.2.0` outputs into owner-visible Raindesk takes without contaminating candidate/artifact manifests with mutable acceptance state. The artist must be able to watch a candidate and say **Keep / Another / Combine / Reject**; those decisions live in the shared `ReviewDecision@0.2.0` authority model.

## Product rule

**A candidate is immutable evidence. A review decision is a separate event. Presentation state is derived from the event log.**

Raindesk must never add `accepted`, `review_state`, approval flags, or mutable lifecycle fields to a sequence candidate or MP4 artifact.

## Acceptance criteria

1. A review ledger writes closed-world `ReviewDecision@0.2.0` events with exactly the shared decision vocabulary: `keep | another | combine | reject`.
2. Candidate/project/sequence/source-snapshot identity is resolved server-side from the imported Raindesk candidate record. Browser-supplied project ids, snapshot digests or candidate metadata are ignored.
3. Only an existing locally imported sequence candidate can receive a decision. The API cannot review an arbitrary external candidate id.
4. The initial artist surface writes `actor_id=owner` and `actor_role=owner` server-side. The browser cannot impersonate `system` or `agent_suggested` authority.
5. Review events are append-only. Editing a previous event is not supported; a later decision supersedes earlier current sequence-level authority through `supersedes_decision_id`.
6. Current sequence review state is derived from the decision log. At most one candidate is the current `keep` for a sequence. `another`/`reject` do not mutate or delete candidate media; `combine` records intent but does not pretend a composite candidate already exists.
7. Decision ids are server-minted. A bounded idempotency key prevents duplicate browser retries from creating duplicate decision events while refusing reuse for different content.
8. Public candidate responses may include a **derived** review summary, but the stored `SequenceCandidateManifest` remains byte-semantically unchanged and contains no review fields.
9. The candidate MP4 is previewed from the Range-capable Raindesk artifact URL; no external `run_dir` or filesystem path reaches the UI.
10. A lightweight Animatic Take card integrates with the Partner drawer/creative desk without replacing the existing image-take loop. It shows candidate identity/fidelity, a native video preview, and Keep / Another / Combine / Reject actions.
11. `Another` creates review intent only in v1; it does not silently rerun the external worker. A later Partner turn may propose a new pacing snapshot or explicit retry.
12. `Combine` records the owner request and returns control to the Partner; no fake merged output is claimed.
13. Reload restores imported candidate cards and derived current review state from server data.
14. Browser/UI tests prove playback URL wiring, decision POSTs, reload restoration, no candidate-manifest mutation and stale/current decision presentation. The full deterministic suite and the relevant native Chromium smoke remain green.

## Non-goals

- No autonomous acceptance.
- No automatic generation of a second pacing interpretation yet.
- No visual-observer sketch interpretation yet.
- No broad timeline editor; the first review surface is intentionally small and reviewer-first.
- No audio waveform/editor controls yet.

## Follow-on gate

Once the review loop is real, the Partner can safely begin proposing multiple **pacing interpretations** from Beats, DIRECT marks and sketch intent. Each interpretation must compile to its own explicit ordered/duration snapshot and return as a separate immutable candidate for comparison.
