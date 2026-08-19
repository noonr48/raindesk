# Mission Contract — reference-board-overlap-v1

Branch: `chatgpt/reference-board-overlap-v1` (off hardening `a53749f`). Owner-delegated autonomous slice; closes the two deferred adversarial findings from the hardening cluster.

## Mission

Close A7 in `public/js/reference-board.js`: (1) document-listener accumulation across renders, (2) overlap double-claim when two cards' rects intersect — **without regressing any green journey step** (move, resize, rotate persistence; deliberate control clicks; reload survival; 409 merge). Three prior same-class fixes each regressed a green step; the STUCK kill reverted them. This slice exists because a witness now exists to make the fix provable.

## Acceptance (all mandatory, suite-last)

1. `npm test` **231/231** green (the A2/A3 execution regression added at `a53749f` must stay).
2. Reference-board browser smoke green end-to-end (real entrypoint, zero mocks).
3. **Lab-120 witness**: document `pointerdown` count **flat** across ≥5 rotate revisions (drops allowed; growth forbidden) — `/tmp/rd-leak-wit-probe.js` pattern, probe promoted into `dev/`.
4. **Overlap probe**: two imported cards, overlapping rects, drag from the intersection — exactly ONE card moves; the other stays put (negative: no double-claim).
5. Dual-lens review (spec + adversarial) machine-accepted five-line packets.

## Constraints

- No regression of the three persistence properties that killed past attempts (the regression history is the contract's spine).
- No second generation path; no auto-GEN; surface-handoff semantics untouched.
- Suite runs **after** every artifact-affecting mutation; check before prose.

## Standing blockers (owner-gated, not this slice)

Owner taste verdict (delivery msg `7a61439f`: 1 / 2 / roll / controlnet) — sole owner-gated input. ComfyUI 8188 restoration — infrastructure. Three stale smokes (creative-desk, director-loop, creative-sheets) — later slice.
