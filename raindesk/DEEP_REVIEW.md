# Deep-review: raindesk-v1-release

Band: GATED (F=16 C=7 I=1 S=1) · Medium: code · Date: 2026-08-14 · Status: OPEN

## SPEC (R-G1)

ASK (VERBATIM): "yes. that looks great. let's agentically build, test, review and refine agentically. make a version fot he desktop as well. use as much sub-agents as you want. agentically autonious proceed"

Clauses (the WHAT):
| # | clause (the ask's words) | evidence artifact | verdict |
|---|---|---|---|
| 1 | "agentically build" | app live: curl tailnet → `LIVE 200`; 10 commits a7b6918..10d3b97 | MET |
| 2 | "test" | receipted suite `file-inspection-test_run-6a33323aad2d6d84` → `ℹ pass 35 / fail 0`, exit 0 | MET |
| 3 | "review" | 6 reviewer waves dispatched; final two strict-form packets: `FINDINGS: none / VERDICT: pass / FOLLOW-UPS: none` (spec + adversarial, verbatim in transcript) | MET |
| 4 | "refine agentically" | repair waves from blocked verdicts: 716b5cd, 2280dc6, aedc9fd, 10d3b97 (each = review finding → fix → suite green) | MET |
| 5 | "a version for the desktop as well" | `app.css:374 @media (min-width:1024px)` docked drawer; 1440px headless screenshot delivered (vault msg 5aba67d5); reviewer-verified both waves | MET |
| 6 | "use as much sub-agents as you want" | 13 children across 9 waves (analyst/builders/reviewers), ledger log_id 6750/6752/6753 | MET |
| 7 | "autonomously proceed" | owner input only at start; all repairs, dispatches, releases executed without asking | MET |

Instructions (the HOW — from BUILD_BRIEF + owner directives):
| # | instruction | honored — evidence |
|---|---|---|
| 1 | Owner never sees terminals/ComfyUI/paths | UI = bubbles+canvas only; delivery via artifact-delivery msg 5aba67d5 |
| 2 | Never touch /home/studio/ComfyUI trees; HTTP only | comfy.js uses fetch only (grep: no fs writes in lib/comfy.js); reviewers verified |
| 3 | One generation at a time | queue.js serial chain + `two jobs run sequentially` test green |
| 4 | Commit prefix `raindesk:` | `git log --oneline` — all 10 commits prefixed |
| 5 | Phone-first; no external resources | AC-7 scoped grep 0 hits (reviewer-verified) |

## EVIDENCE (R-G2)

RAN (last action): receipted suite (below, run after this file's commit) → pasted in closing message.
GREEN: `ℹ tests 44 / ℹ pass 44 / ℹ fail 0` — receipt `file-inspection-test_run-2d56d817991d37f3` at HEAD b7152d6 (grew from 35 with the foundation pass: mirror, shot-switch, tool-state pin tests).
NOT-HAPPY: negative probes green — `negative routes: 404s and bad uploads` ✔, `runInpaint rejects non-PNG buffers` ✔, `gen errors surface as status error` ✔, `chat concurrency: 429 when 3 in flight` ✔ (all in receipted output).
PROOF-CREATION: 44 tests at HEAD (35 from the v1 mission + 9 foundation-pass tests: assets mirror round-trip/traversal, gen mirrored passthrough, board lanes, tool-state honesty, artboard CSS-var pinning, desktop dock, gradient backdrop), incl. `reversed-point lasso…` discriminator — mutation-proven via mutation_probe.py (count-only mutation → 1 fail → reverted).
INHERITED (S=1): sub-agent backend — primary re-ran its suite (fixed deps-key seam + mock bug, 20/20→29/29); frontend — primary re-ran (35/35 total); reviewer citations spot-grounded (canvas.js:596-601, server.js:285-303 re-read by primary).

## WIRING (R-G2.5)

CONSUMERS: grep systemd user+system dirs + crontab for `raindesk` → zero hits; consumers = managed-process registry (at v1 close: pid 2143874; since 2026-08-16 checkpoint-swap restart: wrapper 684087 / node listener 684095) + Vault msg 5aba67d5 + this repo. Frontend fetches only `/api/*` same-origin.
REACHABILITY: server serves the app (`LIVE 200` tailnet + root); ACTIVATION: restarted after each server-code mutation (pid 2143874, started 18:19:58Z; 10d3b97 is test-only — no restart owed) — nothing holds an old version.
TWINS: preset candidates `raindesk/presets/creative.txt` (canonical) + `lib/presets/creative.txt` (landing) — agent.js prefers first-existing, tested (`loadPreset prefers a preset file…`).
CONSISTENCY: palette = exact CSS vars from brief (reviewer-verified, mockup v1.1 lineage); naming (lib/ singular modules, tests colocated) uniform.
INSTRUMENTATION: new runtime seam (chat concurrency) → test row landed (`chat concurrency: 429…`); no seam ships unprobed.
DERIVED-DIFFS: `raindesk/data/` is runtime-only, gitignored (commit 908df6c) — none staged.
RIPPLE: frontier empty (test-only last commit; no wiring updates outstanding). join ledger: n-a (no joinery seams this mission).

## ADVERSARIAL (R-G3)

MIRROR:
- WEAKEST: mutation-probe ran raw (not oracle-receipted) → covered by receipted suite re-runs proving the revert clean (35/35 ×2 post-probe).
- MISSING (shift: cold user opens URL tomorrow): server must survive reboot — RESIDUAL R1 (auto-restart not yet wired); demo-fallback path tested in api.js design + offline path present.
- PUNTS: companion persona/name + emoji pack deferred to owner (v2 backlog); 0.0.0.0 unauthenticated bind = trusted-tailnet punt (same as vault-app); disclosed in delivery.
PREMORTEM: 1) pi headless json contract drift (message_end shape) breaks chat → fallback keeps app usable; 2) ComfyUI GPU/topology change breaks gen → 502 surfaced per-job, never wedges UI; 3) tailnet IP change breaks the URL (delivery artifact + memory note).
FIX-CLAIMS: agent-bridge fix narrative ("json mode, argv, parseReply") verified by live receipts (real companion replies ×3, distinct text, no fallback string).
CLASS SWEEP: concurrency-boundedness searched across endpoints — gen (MAX_PENDING=4) + chat (CHAT_CONCURRENCY=3) both capped and tested; no other spawn/queue surface (grep).
REVIEWER (GATED): dispatched xna-reviewer ×2 final waves (spec + adversarial), focus seams named, rationale withheld.
→ VERDICT: pass / findings: none / pass / findings: none · cycle: 3 (two prose-form rejections, then strict) · mechanism: clean.

## CLOSE (R-G4)

TRACE:
| clause | change | evidence |
|---|---|---|
| build/test/review/refine/desktop/agents/autonomy | raindesk/ app, 13 commits, 44 tests, 8 waves, live server | receipt 6a33323aad2d6d84 + 2d56d817991d37f3; LIVE 200; vault 5aba67d5; strict packets in transcript |

RESIDUALS:
- durability R1: server survives manual restart only — fires when studio-server reboots → fix = systemd user unit (owner-approved service install).
- drift R2: pi json-contract change → fires on pi update; revisit trigger in memory af0cbc23.
- exposure R3: unauthenticated tailnet bind → fires if network context changes; hardening option filed.

ACTIVATION:
- raindesk-server: LIVE now — wrapper pid 684087 / node listener 684095 (restarted 2026-08-16 03:29:55 +0930 after checkpoint swap 8324d00; live-gen proof in evidence/owner-challenge-3c6c6eccdd7e-1.md). The old v1-mission pid 2143874 is retired. companion-mockup-v1: INERT artifact of the v1 mission, not part of the live app; the process earlier believed to be it (pid 1927) is actually the Vault messaging app (vault-app) and was deliberately left running.

TRIAD:
(a) changed: raindesk app (16 files), 5 repair commits, 1 test commit.
(b) evidence: build→LIVE 200 · test→35/35 receipted · review→2 strict passes · refine→4 repair commits each gated green · desktop→@media + screenshot.
(c) blocked: nothing engineering-blocked; v2 items are taste-owned by the owner.

STOP: clean pass — no new verdict-changing finding in this sheet. Status: CLOSED
