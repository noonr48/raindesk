# AGENTS.md — orientation for AI coding agents working in Raindesk

Welcome. This repo is built **by agents, for a human reviewer** — the discipline
below exists because agents wrote every line of it, and it is what kept the
quality honest. Follow it.

## What this is

Raindesk is a creative companion web app for producing an animated film:
world-space canvases, revisioned sketch sheets, beat-scoped visual directing,
an immutable-reference board, and a durable approval ledger for agent-proposed
edits. Vanilla JS + zero-dependency Node. Read `README.md` §2 for the surface
map and `raindesk/BUILD_BRIEF.md` for the original mission contract.

## Run it

```bash
cd raindesk
npm test                 # 231 assertions — run this after EVERY change
node server.js           # serves 127.0.0.1:17600 by default
```

- Data lives in `raindesk/data/` (gitignored). For scratch work:
  `RAINDESK_DATA_DIR=/tmp/scratch node server.js` — never run experiments
  against the production data dir.
- PORT is hard-coded 17600 (`server-core.js`). Production binds 0.0.0.0 with
  the env trio documented in `raindesk/DEPLOY.md` — read it before touching
  deployment.
- Browser journeys live in `raindesk/dev/browser-*-smoke.js` (headless
  Chromium over CDP; `CHROME_BIN=/usr/bin/google-chrome-stable`). They are
  zero-mock, real-entrypoint tests; run the one touching your change.

## The non-negotiables

1. **Suite after every mutation.** `npm test` green is the floor, and it must
   postdate your last change. A browser smoke covers UI-touching changes.
2. **Read before writing.** Never edit a file you haven't read; grep callers
   before changing a shared symbol.
3. **Mission contract before implementation** on anything substantial —
   testable acceptance criteria first (`MISSION-*.md` files are precedents).
4. **Receipts over narration** — claims cite commands that ran. The repo's
   review packets and evidence files (`raindesk/evidence/`) are the house
   style.
5. **No secrets in history.** The repo is public; tokens, keys, and internal
   hostnames stay out of commits.

## Where things live

- `raindesk/lib/` — server modules (each `*_V1.md` doc beside its surface)
- `raindesk/public/js/` — client surfaces (creative-desk, creative-sheets,
  beats, reference-board, surface-handoff, app)
- `raindesk/tests/`, `raindesk/lib/tests/` — unit + route tests
- `*.md` caps files — design docs per subsystem; read the one you touch
- Branch convention: stacked feature branches (`chatgpt/*`, `feat/*`);
  main stays releasable
