# Mission — Animatic Execution v1

Baseline: `chatgpt/animatic-adapter-slice-v1` after exact-snapshot preparation and invocation-origin/lifecycle hardening.

## Goal

Complete the first real production hand-off: an **approved, server-prepared invocation bound to one immutable `SequenceSourceSnapshot@0.2.0`** may launch the configured video-skill `animatic_timing_v1` executor, import its output as a Raindesk-owned immutable sequence candidate, and leave acceptance to a separate review decision.

## Product rule

**Execution may produce evidence and candidates. It may never turn a candidate into accepted creative state.**

The configured video skill is an external worker, not a project authority. Raindesk validates every input before launch and every returned artifact before it becomes visible.

## Acceptance criteria

1. `RAINDESK_ANIMATIC_EXECUTOR` is treated as one absolute executable path, never a shell command. Relative paths, command strings/arguments, missing files and non-executable files do not register an operational animatic adapter.
2. The execution bridge launches with `spawn`/`execFile` semantics and `shell:false`. Snapshot path, project root and run root are distinct argv entries; no user text is interpolated into a shell command.
3. Execution accepts only a ledger row with `origin=server_prepared`, adapter/capability `animatic_timing_v1`/`animatic_timing`, a valid `sourceSnapshotDigest`, and lifecycle `approved`. A coarse Partner proposal, HTTP-legacy row, stale/cancelled row, or unbound approval is refused.
4. The source snapshot is re-read from Raindesk storage and integrity-verified immediately before hand-off. The external worker receives that exact persisted snapshot path; browser-supplied panel paths or snapshot documents are not accepted by the execution route.
5. `RAINDESK_ANIMATIC_PROJECT_ROOT` is one absolute configured directory. Each external attempt gets a unique child project directory underneath it. The child process receives `SLOANE_VIDEO_ALLOWED_ROOTS` set to that configured root, bounding the executor's video-project filesystem authority.
6. External attempt output is written beneath a Raindesk-controlled run directory. Any reported `run_dir` outside that root, path traversal, symlink escape, or manifest file outside the committed attempt directory is rejected.
7. Raindesk validates the returned `ExecutionAttempt@0.2.0`, copied source snapshot, and `SequenceCandidateManifest@0.2.0` semantically enough to enforce identity/digest/adapter/candidate bindings before import. Candidate review state is forbidden in the imported manifest.
8. Every candidate file is re-hashed and byte-count checked against the candidate manifest. V1 imports only `video/mp4`; unsupported or mismatched files fail closed.
9. MP4 bytes are mirrored into a Raindesk content-addressed video-artifact store. Candidate records reference immutable SHA-backed local artifacts; external run paths are never exposed to the browser or Partner.
10. Candidate records contain no acceptance fields. Review/acceptance remains a separate follow-on `ReviewDecision` authority.
11. Execution attempts have a durable Raindesk lifecycle (`running|succeeded|failed|interrupted`) separate from invocation identity and external attempt identity. Concurrent duplicate execute calls cannot double-launch the same approved invocation.
12. On process restart, locally `running` attempts are marked `interrupted`; they are never misreported as successful. Explicit retry may create another execution attempt against the same immutable approved snapshot without changing its authority.
13. The invocation moves `approved -> handed_off` only after the child process actually starts. Spawn failure leaves the invocation approved so configuration can be repaired safely.
14. A successful invocation is idempotent: a repeated ordinary execute request returns the existing successful candidate rather than launching the external worker again. A failed/interrupted attempt requires explicit `retry=true`.
15. stdout/stderr are bounded, timeout is bounded, non-zero exit or malformed result is recorded as failure, and no external path or command leaks through public responses.
16. The API exposes bounded execution status/candidate metadata and a Range-capable MP4 artifact endpoint suitable for browser preview.
17. Deterministic tests use a temporary fake executable to prove argv boundaries, no-shell behavior, successful import, hash/path validation, malformed/non-zero failures, duplicate-call suppression, restart recovery, explicit retry and Range serving. The full Raindesk test suite remains green.

## Non-goals

- No automatic `keep` decision.
- No broad Editorial/Composition/Motion/Audio IR expansion yet.
- No visual-observer interpretation of sketches yet.
- No high-fidelity motion/video generation adapter yet; this is the static-panel animatic slice.
- No reliance on the private video-skill repo being present in CI; the bridge contract is tested with a fake executor and can be live-proven on the owner's host separately.

## Follow-on gate

After this backend execution slice is accepted, build the owner-visible **Animatic Take** surface and a `ReviewDecision` ledger (`keep | another | combine | reject`) over imported sequence candidates. Only then should the Partner begin proposing multiple pacing interpretations from sketch/beat intent.
