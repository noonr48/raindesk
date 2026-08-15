# Raindesk v1 — Build Brief (the crew contract)

Owner green light: 2026-08-14 ("agentic autonomous proceed; desktop version too; use sub-agents freely").
Design contract: `open-design-artifacts/companion-app-v1/index.html` (mockup v1.1, vision-verified) + memory entry `46a3501c` (interaction spec).

## Product (one paragraph)
Raindesk: a creative companion app for "After the Last Rain". Full-screen layered canvas showing the current shot page; free-lasso + pen tools; GEN button runs context-aware inpaint via local ComfyUI and paints the result as an in-place TEMP overlay inside the lasso region (never a mini preview); re-GEN cycles takes; COMMIT merges the chosen take into the active layer; ✕ discards. A side drawer (three-line handle) holds the agent chat (real agent via `pi -p` headless) and a "my gens" tab. Board lanes (set / in dev / unplanned) as quiet counters. Phone-first layout AND a desktop-adapted layout (drawer docked as a side panel ≥1024px, larger canvas, same flows). Fun, friend-toned agent copy with emojis. Palette: rain-teal #0e2129/#132b34/#1d3a46/#2e5666, lantern-gold #e8b04b/#b8893a, cream #f3ead8, coral accent #e07856 (from mockup CSS vars).

## Architecture (fixed decisions — do not relitigate)
- **Tree**: `/home/studio/lab/creative/after-the-last-rain/raindesk/` (inside the existing git repo; commit per coherent cluster).
- **Backend**: Node.js ≥18, zero-build, `server.js` + `lib/` modules. Serves static `public/` and the JSON API on **127.0.0.1:17600** (loopback; private-mesh exposes it). [Built deviation, commit 716b5cd: binds `0.0.0.0:17600` — reachable on EVERY interface of the host (home-LAN NICs, tailnet, docker bridges), and the API is unauthenticated; set `RAINDESK_HOST=127.0.0.1` to restore this brief's loopback intent (server.js:40).] No framework beyond node:http if possible (deps allowed only if genuinely needed; prefer none).
- **Frontend**: `public/` — vanilla JS + CSS (no build step). Canvas engine in `public/js/canvas.js` (layers, lasso path, pen strokes, overlay compositing), UI in `public/js/app.js`, chat in `public/js/chat.js`. CSS vars carry the palette. Responsive: single column <1024px (drawer overlays), desktop ≥1024px (drawer docked right, canvas fills).
- **Generation bridge**: `lib/comfy.js` — POST workflow JSON to `http://127.0.0.1:8188/prompt`, poll `/history/{id}`, fetch outputs from `/view`. **Workflow**: SDXL inpaint on `Illustrious-XL-v0.1.safetensors` (checkpoint swapped 2026-08-15 from z-anime-base-aio-bf16, which produced structureless mush across 3 takes; swap evidence + live-gen proof: `evidence/owner-challenge-3c6c6eccdd7e-1.md`) — LoadCheckpoint → CLIPTextEncode (positive/negative from request) → LoadImage(image) + LoadImageMask or InpaintModelConditioning → VAEEncodeForInpaint → KSampler (steps ≤ 24, cfg ≤ 6, dpmpp_2m/karras) → VAEDecode → SaveImage. Discover exact node names from live `/object_info` before finalizing (server has custom nodes). Feather the mask ~16-32px client-side before upload so blends are soft. Save outputs under unique prefixes `raindesk/{shot}/{ts}`.
- **Agent bridge**: `lib/agent.js` — spawn `pi -p --mode text --no-session --append-system-prompt <creative-preset>` with the user message + compact context (current shot id, board JSON, last 6 chat turns) on stdin; stream nothing; return final text. Creative preset path: `raindesk/presets/creative.txt` — friend-toned, emojis, concise, never mentions internal machinery, NEVER leaves the user alone (if it dispatches nothing itself, it just chats), knows the film constraints (Anna=15 two-arms etc. from BOARD.md), default casual. Timeout 120s → friendly fallback line.
- **State**: `data/board.json` (lanes + shots; seeded from ../BOARD.md S01-S07: S01-S03 breakdown→in dev, S04-S07 queued→unplanned) + `data/shots/{id}.json` (layers, history pointers). All writes atomic (tmp+rename). REST: GET /api/board, POST /api/board/move {shot,lane}, POST /api/gen {shotId, layerId, maskPng, regionPng, prompt} → {jobId}, GET /api/gen/{jobId} (pending|done{imageUrl}|error), POST /api/commit {shotId, layerId, tempUrl} (merge server-side via canvas-compose in node using pureimage or client sends merged PNG — simpler: client merges on canvas and POSTs the merged layer PNG; server stores it), POST /api/chat {message} → {reply}.
- **Safety**: loopback bind; no shell interpolation of user text (pi gets stdin, ComfyUI gets JSON); file-type validation on uploads; generation jobs queued one-at-a-time per server (lib/queue.js, simple promise chain).

## Acceptance criteria (the reviewer contract)
1. `curl 127.0.0.1:17600/` serves the app; phone viewport (390px) shows full-screen canvas + handle; desktop (1440px) docks the drawer — headless-chrome screenshots of BOTH prove it.
2. Lasso→GEN→overlay: automated or scripted e2e — POST /api/gen with a real mask+region on a seeded test shot returns an overlay URL of a real ComfyUI output whose decoded region differs from the source region (pixel diff > threshold) and whose surroundings are preserved. Receipt required.
3. COMMIT: after commit, GET of the shot's active layer equals base⊕overlay composite within the mask (pixel test in tests/).
4. Pen: strokes recorded as vector data, rendered on layer, color/thickness configurable (unit test on canvas.js state machine; no DOM needed for logic).
5. Chat: POST /api/chat returns a non-empty reply ≤120s (pi bridge live; graceful error JSON if pi missing).
6. Lanes: board.json round-trips through move; UI counters reflect it.
7. No external network resources in the frontend (self-contained; fonts system).
8. Tests: `tests/` with node:test — run `node --test tests/` green; every mutation accompanied by a green run. Vision-verify final UI on both layouts before release (primary's job).

## Constraints (hard)
- Never touch /home/studio/ComfyUI trees or models; only HTTP.
- One generation at a time; GPU state re-checked before enqueue (the server was just restarted by the primary).
- Owner never sees: terminals, ComfyUI, paths — only the app.
- Commit style: small, coherent, message prefix `raindesk:`.
