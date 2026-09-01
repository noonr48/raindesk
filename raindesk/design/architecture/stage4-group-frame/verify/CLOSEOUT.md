# CLOSEOUT — Stage-4 first-class group frame (G1–G6)

Executed 2026-09-01 on `chatgpt/raindesk-v2-integration`.

| step | commit | verify (run after the step's last mutation) |
|---|---|---|
| Shelf | `8889bf5` | scope + G1-G6 skeleton |
| G1 server frame | `06e52bc` | lib discriminators (derivation/explicit/version-guard/bad-values); suite 464/464 |
| G2 render at frame | `a14a64d` | switchTab byte-identical-geometry discriminator; suite 465/465; journey 26/26 |
| G3 frame lifecycle | `4981091` | drag/maximise battery discriminator; suite 466/466; journey 26/26 (one step-24 transient, passed on all re-runs) |
| G4 group gesture lock | `2c62445` | refused second-pointer tear discriminator; suite 467/467; journey 26/26 |
| G5 reload restore | `8522a6d` | frame-carrying-doc discriminator; suite 468/468; journey 26/26 |
| Spec repair | `3c9f0d4` | F1 resize-commit-on-member-lane, F2 cancel-clobber, F3 dead frameMaximised — fixed + extended discriminator; suite 469/469; journey 26/26 |
| Impl repair | `d0eba4c` | F1 stale expectedGroupVersion, F2 discarded 409-detail group, F3 missing wire-side leave — fixed + 3 race discriminators + fixture realism (membership tracking, setFrame echo, rejectOnce hook); suite 472/472; journey 26/26 |

## Dual review chain

- **Spec lens**: full pass (G1/G2/G4/G5 clean; G3 blocked on 3 seams) → repair `3c9f0d4` → focused re-review **pass, findings none**.
- **Implementation lens**: full pass (verified-clean: gesture-key collisions, abort ordering, resize cancel, renderFrame orderings, server transactionality, test honesty) blocked on 3 concurrency seams → repair `d0eba4c` → focused re-review **pass, findings none, follow-ups none**.

## Named follow-ups (implementation lens; non-blocking, recorded)

1. z-order authority coherence: bringToFront bumps model.zIndex only; frame.zIndex and reload-seeded zTop can diverge — reconcile when z-order authority is touched next.
2. Legacy frame-null groups: persistFrame early-returns; server lazy-adoption unreachable from this client (coherent member-lane fallback) — decide client-side derivation or document the fallback if legacy pre-Stage-4 data matters.
3. G4 lock bypass window: a gesture keyed under `group:<provisional>` during the create-response swap allows a second contact to acquire under `group:<server>` — re-key activeGestures on swap when the swap path is touched next.
4. The fixture's rejectOnce hook covers one fault per test — extend if multi-fault races need pinning.
