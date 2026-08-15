# Raindesk development preview

Raindesk remains a **local-first production application**. The mock runtime exists only so UI/UX, storyboard, layer, lasso, generation-take, commit, and companion flows can be developed in a disposable environment without the owner's physical machine, Pi, ComfyUI, or GPUs.

## Commands

From `raindesk/`:

```bash
npm test
npm run dev:mock
npm run preview
```

- `npm run dev:mock` starts the real Raindesk server/UI with deterministic fake Pi + ComfyUI adapters.
- `npm run preview` starts an isolated mock server, renders the real app in headless Chromium/Chrome at **1440×900** and **390×844**, writes screenshots to `artifacts/preview/`, then removes its temporary data directory.
- `npm start` remains the production/local entry point and is not redirected through the mock runtime.

If Chromium is not discoverable on `PATH`, set:

```bash
RAINDESK_CHROMIUM=/path/to/chromium npm run preview
```

## Disposable virtual environment

`.github/workflows/raindesk-preview.yml` is the shared virtual runner. Pull requests affecting Raindesk run the test suite, render both preview sizes, and upload the screenshots as the `raindesk-preview` artifact. This is the preferred ChatGPT-assisted prototype loop because it requires no bridge to the owner's physical machine.

## Runtime boundary

Production:

```text
Raindesk UI → server.js → Pi + ComfyUI
```

Virtual prototype:

```text
Raindesk UI → server.js → mock agent + mock generator
```

The canvas, API routes, shot state, lasso, layers, take session, commit behavior, and frontend remain the same in both modes. The mock generator deliberately produces obvious abstract placeholder takes; it is not intended to approximate final image quality.
