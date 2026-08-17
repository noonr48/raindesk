# Character Anchors v1 — validation state

Continuation audit after the previous ChatGPT context limit found that the Character Anchors feature modules and tests had landed, but four application join points had not: authenticated character registry routes, server-side shot-character injection into Partner turns, bounded Partner prompt authority, and browser API/bootstrap wiring.

The repair commit composes those joins without rewriting the inherited engines:

- `server-core.js` preserves the previous server byte-for-byte; `server.js` composes authenticated Character routes and authoritative shot context.
- `lib/partner-core.js` preserves the previous Partner engine byte-for-byte; `lib/partner.js` adds bounded `characterAnchors` prompt authority and explicit visual-evidence semantics.
- `public/js/character-api.js` adds the Character registry / shot-binding client surface.
- `public/index.html` loads the Character API extension before `character-anchors.js`.
- `lib/tests/character-joinery.test.js` protects those joins from being omitted again.

Focused local harnesses passed for server route/context injection and Partner prompt compaction/semantics, and all new JavaScript passed `node --check` before commit.

The earlier `174/174` full deterministic-suite claim must not be treated as current acceptance evidence: it described the pre-audit state even though the application joinery above was absent. The full repository suite and the seventh native Chromium journey still need to be rerun on the repaired head. GitHub-hosted execution remains subject to the existing Actions runner billing/spending-limit block; a runner-allocation failure is not product acceptance evidence.
