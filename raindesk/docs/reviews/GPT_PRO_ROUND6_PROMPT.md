# GPT Pro review request — Raindesk Freeform Creative Desk v2, ROUND 6

You are reviewing a browser-based creative desk (vanilla-JS floating window manager over an art application). Round 6. Round 5's verdict is committed at `docs/reviews/GPT_PRO_ROUND5_VERDICT.md` — read it first. Its bounded fix-now slice is implemented AND every mechanism now carries a discriminator test that fails on the pre-fix code.

## Repo access

- REPO: github.com/noonr48/raindesk (private; you have connector access)
- BRANCH: `chatgpt/freeform-desk-v2`
- HEAD: `dd53957`

## What changed since round 5 (commits to review)

1. `d0afe00` — round-5 triage: close-delete error classification (only confirmed 404 = success; 409 adopts+retries once; transport/auth/5xx re-throw visible), dock lifecycle invariant (transition clears the stored edge on every exit from docked except to the shelf; init repairs stale docks on floating/tabbed rows and persists the repair), shelf dock-restore clears collapsed, full resize rollback {rect,state,dock,collapsed}, tab/shelf pointer capture (release-outside terminals always delivered), registry deep-freeze, state() exposes dock.
2. `7cd778e` + `dd53957` — test-only repairs closing two blocked review verdicts: warn-path 5xx discriminator, both-attempts-fail (409→retry→5xx) discriminator, registry deep-freeze discriminator (frozen clones + detached sources), tabbed-row stale-dock repair discriminator.

## Step 1 — gather current status from the repo

Read: `docs/reviews/GPT_PRO_ROUND5_VERDICT.md`, `public/js/window-manager.js` (close chain ~:862-903; transition dock invariant; init repairs; resize snapshot/rollback; kernel; policies), `tests/frontend/freeform-window-manager.test.js` (the round-5 discriminator block at the end), `dev/browser-freeform-desk-journey.js` (step-19 canonical witness).

## Step 2 — produce the review AND the stage-1 design

- Q1. Round-5 fix verification: are the implemented mechanisms sound and now adequately discriminated? Hunt residuals the tests still miss.
- Q2. Design task (this round's centerpiece): a concrete protocol design for your TOP-1 — identity-safe, intent-based lifecycle/group/shelf transactions. Specify: the intent operation set (names + payloads), the identity model (incarnation/generation vs tombstone), the revision model (how structural revisioning separates from spatial/viewport), conflict semantics (what conflicts, what merges), the REST surface, the client adoption rules, and a migration path from the current setGroups/setShelf/upsert/delete routes without breaking the legacy clients in the tree. Anchor every choice to the specific races it kills (name them).
- Q3. Sequencing check: does anything in your round-5 findings change your 6-stage order?
- Q4. New seams in the three commits not covered above.
- Q5. Anything from the round-5 verdict you now consider wrong or overstated.

## Output contract (strict)

- Findings ONLY, severity-ranked (critical/major/minor). No praise.
- Each finding: [severity] location anchor (file + function/range) -> mechanism (input -> bad outcome) -> concrete recommendation -> acceptance test.
- The Q2 design goes in a clearly-marked `## STAGE-1 DESIGN` section — it is requested content, not a finding; be concrete enough to implement from.
- End with: TOP-3 next work items ranked by impact/effort, each with an acceptance criterion.
