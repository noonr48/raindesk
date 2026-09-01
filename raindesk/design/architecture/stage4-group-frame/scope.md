# scope.md — Stage-4: first-class group frame (Round-6 [major] group finding)

## Problem
A group is still a collection of complete independent windows (Round-6 GPT_PRO_ROUND6_VERDICT.md:19): members retain different rects, z-indices, presentation states, restore states, gesture locks. Switching tabs jumps the visible frame to another member's rectangle; hiding depends on `state === "tabbed"`; a member flipped to docked/maximised stays visible under another active tab; separate member ids can hold simultaneous gestures against what is perceptually one frame.

## In Scope
- A first-class GROUP FRAME owning geometry, presentation, z-order, focus, and gesture identity — exactly one rendered frame per group; the active member's CONTENT mounts in it; switching tabs swaps content, never geometry.
- v4 protocol: groups gain a canonical `frame` (rect + presentation + zIndex) owned by the group record; members keep WindowRef identity + ordering ONLY while grouped (their own rect/presentation go latent); group ops mutate the frame (frame.set/dock/maximise/… ride the existing group revision discipline).
- Client WindowManager: one frame element per group (group-scoped gesture lock; member gestures target the group); reload restores the frame once.
- Acceptance discriminators: group windows with deliberately different geometry → tab switch never moves the frame; resize/dock/maximise/minimise/restore/reload operate on the group frame; gestures from two member tabs governed by one lock; exactly one content member visible.

## Out of Scope
- Viewport recovery/matrix (Stage 5), keyboard/a11y (Stage 6), adapter family.
- Member-level independent rects while grouped (that is the removed model).
- Non-grouped windows (unchanged single-window model).

## Success Criteria (measurable)
1. BINARY discriminator: members with different rects grouped → switchTab keeps the frame's rendered rect byte-identical (content swaps only).
2. BINARY: resize/dock/maximise/minimise/restore on a grouped window mutate the GROUP frame (server readV4 witness: group.frame changes; member rows' spatial untouched).
3. BINARY: a second pointer gesture on another member tab while one is live is refused by the group-scoped lock.
4. Suite green; journey 26/26 (group steps now exercise the frame); animatic smoke ok.

## Constraints — Round-6 order (Stage-4 after ownership retirement); expand-contract on the protocol (group.frame additive; old readers see unchanged groups); Stage-1's canonicalized membership is the foundation (no premature geometry encoding to unwind — members' latent rects remain in their rows).
