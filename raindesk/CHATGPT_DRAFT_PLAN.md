# Raindesk Draft — ChatGPT surface plan

## Decision

The local Raindesk application remains the canonical production environment. A future ChatGPT plugin/app should be a **lightweight drafting and review surface**, not a cloud replacement for the local app and not a second production image-generation stack.

## ChatGPT surface should focus on

- rough storyboard framing and shot intent
- visual critique and continuity discussion
- pen/lasso annotations that make references like “this area” model-visible
- alternate composition ideas and early drafts
- character/story/environment reasoning
- exporting a compact draft/review package for the local Raindesk app

## Keep local-only / production-first

- final inpaint/generation and model control
- ComfyUI workflows, ControlNet/reference conditioning, masks and generation settings
- production layers/compositing/history
- project filesystem and local assets
- Pi harness orchestration and specialised production agents
- GPU-dependent work

## Interchange contract direction

The two surfaces should communicate through an explicit Raindesk draft package rather than a live bridge to the owner's physical machine. The package should be able to carry, at minimum:

```json
{
  "project": "after-the-last-rain",
  "shot": "S03",
  "frame": "S03-F04",
  "intent": {
    "purpose": "what the shot is meant to communicate",
    "emotion": "quiet uncertainty",
    "camera": "medium-wide"
  },
  "references": [],
  "annotations": [],
  "draftImage": null,
  "notes": []
}
```

Coordinates in annotations should be normalized (0–1) so packages survive different viewport sizes. The final schema should be versioned before the ChatGPT plugin is implemented.

## Order of work

1. Make local Raindesk easy to run and preview in disposable virtual environments.
2. Continue refining the local UI/UX and production workflow against the real app.
3. Define/version the draft package from workflows we actually use.
4. Build the ChatGPT Raindesk Draft plugin only after the required interaction set is clear.
