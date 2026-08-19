# Contributing to Raindesk

**License in = license out.** This project is GNU AGPL-3.0 (see `LICENSE`).
By contributing, you agree your contributions are licensed under AGPL-3.0 and
will be shared back under the same terms — that reciprocity is the point of
this project's license.

## The bar for changes

1. `npm test` (231 assertions) green **after** your last change.
2. UI-touching changes run the relevant browser journey in
   `raindesk/dev/browser-*-smoke.js` (zero-mock, real entrypoints).
3. Substantial work opens with testable acceptance criteria (see the
   `MISSION-*.md` / `BUILD_BRIEF.md` precedents) and cites receipts for its
   claims — commands that ran, output observed.
4. Read `AGENTS.md` first — it is the orientation for agent and human
   contributors alike.

## Practical notes

- Node ≥ 20, zero npm runtime dependencies; `node server.js` from `raindesk/`.
- Use a scratch `RAINDESK_DATA_DIR` for experiments; never mutate production
  data dirs.
- PRs: small, single-purpose, stacked branches welcome
  (`feat/<slice>`). Every changed file should be one you have read.
