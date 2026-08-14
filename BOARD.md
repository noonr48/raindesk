# After the Last Rain — Creative Push System (working root)

**Provenance:** packet exported verbatim from `the-box-project` ref `roompc/main` = GitHub `noonr48/the-box-project` main `d934ec4c` (verified equal 2026-08-14). Canonical docs stay in the repo; this root is the Mill + Push working surface so the dirty server repo is never touched by creative automation.
**Vault conversation:** `animaiton/ storyboard` (owner's animation thread; fetch full UUID from `/api/conversations` at build time).
**Design:** the Mill (overnight candidate generation on studio-server + ComfyUI/MiniMax-H3) + the Push (one verb-only daily Vault message) + ingest (owner reply → agent turn → board update → commit via roompc bridge).

## Owner-locked constraints (auto-inject into every mill prompt)

- Anna = source Eris, **15**, two arms + two eyes, blue hair / emerald eyes / dark-green pointed ears / red wolf-emblem hat / oversized weather clothing. Reads as a teenager.
- Migration story first; Laptoon's fall must carry emotional weight; no compression to hit a runtime.
- Fake-father / thirteen-hearts plot removed. Gore reduced in favour of psychology, scale, implication.
- Hethrn: exhausted sinewy middle-aged man + many golden skeletal arms 2–3× his scale curving like a rib cage; faded partial skull behind; never the city-sized skeleton default.
- Novel-first, cultural shorthand only as faint rhythm (no Victorian Laptoon, no museum-Egypt Harramius).
- Collapse is the fixed 13-beat order in `packet/CURRENT_STATE.md` / `packet/SEQUENCE_COLLAPSE_AND_ESCAPE.md`.
- Full decision set: `packet/DECISION_LOG.md` — re-read before every mill run.

## BOARD — shot ladder

States: `breakdown → candidates → picked → polish → fl2va-test → locked`. One owner verb per push: PICK / RED-LINE / SKIP (skip legal, free, offer re-warms on a different channel).

| Shot | Beat (collapse sequence) | State | Next action |
|---|---|---|---|
| S01 | Beat 1 — Names: Anna's manifest, the blank forest-party lines | breakdown | break into 3 candidate keyframe compositions |
| S02 | Beat 2 — First crack: the narrow fracture + advance warnings (ears, papers, lantern flames, rain angle, Tate's coat pulled) | breakdown | break into 3 candidate keyframe compositions |
| S03 | Beat 3 — Tate acts: orders the sisters in, runs back, grips Anna's coat, Liroz catches at threshold | breakdown | break into 3 candidate keyframe compositions |
| S04 | Beat 4 — Full failure: the glass sphere breaks as the door closes | queued | awaits S01–S03 locks |
| S05 | Beat 5 — Ship swept away (water draws, surge, moorings tear; Zephrine aboard) | queued | awaits S04 |
| S06 | Beats 6–8 — city uproots / Hethrn's arms manifest at the tower peak / king's-party cut | queued | awaits S05 |
| S07 | Beats 9–13 — flood, tunnel, boats, the Rain Throat, forest-river exit | queued | awaits S06 |

**Assets:** current working character references (Anna, Hethrn, Tate, Edward, king, etc.) listed with SHA-256 in the repo's `archive/chat-imports/2026-08-09-after-the-last-rain/ASSET_MANIFEST.md` — binaries live in the Vault conversation export; recover before first mill run. The 2026-08-12 location plates (LOCATION_GUIDE) are exploratory until promoted.

## Mill run rules (hard gates)

- First+last keyframe anchors only per generation; chain FL2VA clips per shot (`MiniMax-H3-Exact-FL2VA-api.json`, VAEs cuda:0). Ref2VA for identity-locked shots once ref images land in `ComfyUI/input/`.
- Any GPU enqueue: follow the run-readiness checklist in the miru SHOT.md doctrine (boot state, listener ownership, no foreign-job disruption, ownership-bounded cleanup). Coordinate on GPU state; never kill foreign jobs.
- Test-tier: 864×480 / 15 steps / fresh seed lineage. Quality tier 1344×768 / 20 steps only after a picked shot.
