# Raindesk 🌧️🏮

**A creative companion app for making *After the Last Rain* — an anime adaptation of the owner's *Side story* manuscript.**

Raindesk exists because of one observation: the owner is an excellent **reviewer** and reluctant **producer**. Blank pages stop work; button-chains stop work; tab-switching stops work. So the machine does the producing, the owner reacts — and the reaction *is* the creative act. The product goal is not "a drawing tool"; it is **a place the owner wants to be, where staying costs 30 seconds and still moves the film forward.**

> Status: **v1 shipped 2026-08-14**, autonomously built (owner-approved brief → sub-agent build waves → independent review gates). 44 automated tests, mutation-proven regression tests, receipted verification discipline (see *How we work*). This README is also the surface for **external AI review (GPT Pro)** — questions we want answered are at the bottom.

---

## 1 · Intent

- **Owner = reviewer.** Every loop is: the machine generates candidates → the owner picks / draws corrections / skips. Skipping is always free; offers re-warm later. No streaks, no shame mechanics, no guilt accumulation. (The interaction grammar is borrowed from the owner's own game-design law: *verbs, not branches; offers never expire; refusal is a lawful outcome.*)
- **One surface.** Phone and desktop, nothing else to open. The companion agent lives *in* the app and never leaves the owner alone while background work runs.
- **The agent owns all machinery.** ComfyUI, GPU placement, workflow building, model sync, versioning — invisible. The owner never sees a terminal, a node graph, or a file path.
- **Psychology is a first-class feature.** Variable-reward reveals (each GEN pull is a "will this be THE one?"), visible investment (every correction becomes the agent's carried-forward knowledge), open loops closed kindly.

## 2 · What v1 does today

| Capability | Detail |
|---|---|
| Full-screen layered canvas | 1024×1024 artboard, contain-fit; phone + desktop layouts (desktop: docked companion drawer) |
| **Lasso → GEN → commit** | Free-lasso a region → GEN runs **local ComfyUI SDXL inpaint** (Illustrious-XL-v0.1) that redraws *only* the circled region, painted **in place** as a temp overlay — never a mini-preview. Tap GEN again for another take; **COMMIT** merges the winner into the layer; ✕ discards free. |
| Proven locality | Live receipt: inside-mask pixel Δ167.7/255, outside Δ2.95/255 — it redraws what you circled and preserves the rest |
| Pen & layers | 4-color pen with thickness, layer stack (base/pen/gen), visibility, bounded undo |
| Companion chat | A real agent (headless pi runtime, json-mode) wearing a friend-toned creative preset; knows the film's locked constraints; never times out silently (120 s → warm fallback); concurrency-capped |
| Board lanes | Shots move `set / in dev / unplanned` — glanceable counters, agent-maintained |
| Test discipline | 44 node:test suites; regression tests are **mutation-proven** (we break the code deliberately to prove the test bites — `killproof_deskfit.py`); receipted runs after every mutation |

**Stack (deliberately boring):** zero-dependency Node http backend; vanilla-JS DOM-free canvas core with its own PNG codec; ComfyUI over HTTP only; one-shot headless `pi` turns for the companion. Loopback/tailnet-bound, trusted-home-network exposure model (same as the estate's other tools).

## 3 · How we work (the build discipline)

1. **Mission contract first** — acceptance criteria in `raindesk/BUILD_BRIEF.md` before any code.
2. **Sub-agent waves** — typed builders with non-overlapping write leases; independent adversarial reviewers with strict output contracts; repair cycles gated by the reviewers' verdicts.
3. **Receipts over narration** — every "done" claim carries a machine receipt (oracle-ledger test runs, pixel diffs, form-checked reviewer packets). See `raindesk/DEEP_REVIEW.md` for a full paste-or-fail closeout sheet.
4. **Lessons are durable** — every session's mechanisms land in cross-session memory (e.g. the two-message dispatch protocol that makes machine-gated reviewer packets reliable).

## 4 · Roadmap — the owner's creative process, as direction (v1.1 — amended after external review)

*Captured verbatim from the owner, 2026-08-15; amended the same day after the GPT Pro external review (owner mandate: "take whatever you think is good… and autonomously proceed").*

**Adopted from the review (VC-G5 amendment):** every mark is an instruction, not artwork (markup layer ≠ art layer); every AI result is a reversible take, never a destructive edit; the app — not ComfyUI, not a flattened PNG — is the authoritative document compositor; animation-native frame dimensions (16:9, not the square placeholder); one unified intent composer (the agent infers prompt/correction/question from canvas state); the agent may silently prepare, never silently decide; "Keep this / Another / Not this" replaces commit language; return-state continuity (exact shot, viewport, open loops, resume line); a typed operation registry instead of ad-hoc workflows; a fidelity ladder (thumbnail → blocking → cleanup → style frame → animation anchor); markup/control layers interpreted semantically (shape-first via control-layer interpreter); dropped the variable-reward framing (return because state is preserved and something useful is ready — not slot-machine pulls).

1. **Layer-by-layer generation.** Separable passes — background → characters → effects — each a generatable, editable layer; lazy semantic separation (split subjects only once composition is picked).
2. **Concepts first, shapes first.** Basic shapes/silhouettes/blocking as a cheap shared thinking medium; shapes are constraints the agent interprets (silhouette/pose/depth/line control), never pixels that must survive into output.
3. **Character design anchors.** Locked character sheets condition every generation; identity survives across shots.
4. **Micro ↔ macro switching.** Whole-composition takes and detail surgery flow freely; nothing is lost crossing levels.
5. **Non-linear, messy-process-tolerant.** The agent carries all state (sequence timeline + per-keyframe revision graph + open-loop ledger); jumping around loses nothing.
6. **The agent gets eyes and hands.** Context compiler (shot context packet from the decision-structured docs), visual observer (clean/markup/mask/reference channels), typed operations, candidate critic (scope/canon/continuity checks), project librarian (decisions, rejections with reasons, next useful action).
7. **Open taste question — default imagery.** Unresolved: the register of default imagery, or whether every shot should start from an agent blocking pass instead of any canned default.

**Shipped in the 2026-08-15 foundation pass:** tool-state honesty fix (UI pin test), same-origin asset mirroring (phone-safe delivery via /api/assets), real shot switching (click chips/title, `[`/`]` keys, last-shot restore).

## 5 · Repo map

```
raindesk/            the app (server.js, lib/, public/, tests/)
  BUILD_BRIEF.md     mission contract + acceptance criteria
  DEEP_REVIEW.md     closeout review sheet (paste-or-fail)
packet/              the film's canonical planning docs (story bibles, locked decisions)
BOARD.md             shot board state (S01–S07 seeded from the collapse sequence)
open-design-artifacts/  the UI mockup this app was built from (v1.1, vision-verified)
check_atr_root.py    working-root integrity check
```

## 6 · Questions we want the external reviewer to answer

1. **Loop design:** is lasso→GEN→COMMIT the right primitive set for a reviewer-first workflow, or does it still smuggle producer-work back in?
2. **Layer architecture:** for layer-by-layer generation (roadmap #1), where should layer separation live — ComfyUI workflow layering, prompt-region conditioning, or app-side compositing of single-region gens?
3. **Shape-first concepting:** what's the cheapest faithful bridge from "basic shapes on a canvas" to "detailed generation conditioned on those shapes" (ControlNet-style depth/pose? sketch-to-image? silhouette masks)?
4. **State for messy processes:** how should the agent represent "where things stand" so the owner can jump around without loss — graph, timeline, board, or something else?
5. **Anything in the discipline** (§3) that looks like ceremony rather than safety — we'd rather cut it than worship it.

---

*Built on the SLOANE estate (SSbenbi3). Companion preset and verification receipts live in-repo. The film materials are private and remain so.*
