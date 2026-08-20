# Mission — Animatic Source Snapshot v1

Baseline: `chatgpt/animatic-adapter-slice-v1` at `145d326401da626f56625bcfcdd902cdb70afb4c`.

## Question

Can Raindesk project its own immutable artistic state into the video skill's `SequenceSourceSnapshot@0.2.0` without trusting browser-supplied pixels, paths, revision claims, or inferred sequence order?

This is the authority bridge immediately before external execution. The video executor may only receive a snapshot whose panels can be reproduced from Raindesk-owned immutable shot revisions.

## Product rule

**The animatic may simplify the artwork, but it may not lie about which artwork and directing state it came from.**

Raindesk remains creative authority. A source snapshot is a derived, immutable adapter input. It does not become a second editable project document and it does not accept or reject any output.

## Acceptance criteria

1. Given an explicit ordered list of shot requests, Raindesk resolves each requested `revisionId` (or the current revision when omitted) from `ShotDocument`; unknown/missing revisions fail closed.
2. Raindesk renders each selected ShotDocument revision server-side from its immutable raster blobs plus authoritative vector strokes. The caller does not supply `panel_path`, `panel_sha256`, or panel pixels.
3. Every raster blob is content-hash checked before projection. Missing, corrupt, undecodable, or wrong-dimension raster input aborts the snapshot; no partial snapshot becomes visible.
4. The rendered panel is itself stored through Raindesk's content-addressed PNG store. `panel_sha256` is therefore the actual panel content hash and `panel_path` resolves only from that SHA inside the trusted server.
5. The compiler emits the exact v0.2 contract fields required by the video skill: project/sequence identity, ordered shots, rational fps, dimensions, adapter id/version, fidelity, explicit source-rights assertion, and `snapshot_digest`.
6. `snapshot_digest` is SHA-256 over a deterministic canonical JSON representation of the complete snapshot with only `snapshot_digest` omitted. Repeating the same input state yields the same digest; order, timing, source revision, or creative-state changes yield a different digest.
7. `creative_state_digest` is derived from the bounded Raindesk Direction Graph state for that shot, not from model prose and not from a browser-provided digest. Raindesk does not invent a creative revision ID when none exists.
8. Sequence order and per-shot `durationFrames` are explicit inputs to this v1 compiler. The compiler never guesses editorial order or timing from creation order, filenames, beat prose, or UI position.
9. V1 requires all selected shot revisions to share one canvas size, rejects duplicate shot IDs, bounds shot count/duration, and supports only `draft|preview` fidelity.
10. Compiled snapshots are persisted immutably under Raindesk data by digest with atomic writes. A public/Partner-facing summary omits local filesystem paths.
11. Existing image-generation takes, artwork revisions, Direction Graph data, and accepted creative state are never mutated by snapshot compilation.
12. Deterministic tests cover exact revision projection, vector+raster compositing, digest stability/sensitivity, explicit ordering, stale/missing revision failure, blob corruption, dimension mismatch, and local-path redaction.

## Deliberate boundaries

- This slice does **not** spawn `animatic_compile.py` yet.
- This slice does **not** add MP4 storage or a sequence-candidate review UI.
- This slice does **not** reinterpret sketches with a vision model.
- This slice does **not** infer pacing. A later Partner proposal may suggest durations/order, but those values must cross the normal approval boundary before execution.
- Existing captured shot/beat frame references remain useful directing evidence, but they are not used as production panel authority here; exact ShotDocument revision projection is stronger.

## Follow-on gate

Only after this snapshot compiler is structurally and deterministically verified should the next mission bind an approved invocation to one exact snapshot digest and hand that digest to the configured external executor.
