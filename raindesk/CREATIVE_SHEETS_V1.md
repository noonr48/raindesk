# Raindesk Creative Sheets v1

Creative Sheets v1 turns Creative Desk world sheets from decorative spatial cards into persistent artistic documents.

## Core separation

Two stores have deliberately different responsibilities:

- **Workspace** owns *where a sheet is*: world-space position, size, rotation, scale, visibility and collapsed state.
- **SheetDocument** owns *what the sheet contains*: title, kind, canvas dimensions, raw vector strokes and document metadata.

Moving or putting away a sheet therefore cannot rewrite its drawing history, and drawing on a sheet cannot silently move it on the desk.

## SheetDocument revision contract

Sheet documents use immutable revisions with optimistic concurrency, matching the integrity philosophy already used for shot artwork.

Each write supplies the revision it was based on. A successful edit creates a new revision rather than overwriting the old one. Revision history and restore endpoints remain available independently of workspace placement.

Current document content is intentionally small and raw-first:

- stable `sheetId`;
- artist-editable title;
- kind (`sketch`, `character`, `references`, `notes`);
- canvas width / height;
- raw vector strokes with bounded point arrays;
- bounded metadata.

Raw stroke points are the authoritative drawing material. Rendering is derived from them.

## Artist-facing loop

Desktop Creative Desk now supports:

1. press `+` in the creative tab strip to create a loose sketch sheet;
2. draw directly on that sheet;
3. hold **Space + left drag** or use middle-mouse drag from the sheet to pan the world without creating a stroke;
4. double-click the sheet title to rename it;
5. undo the most recent sheet stroke;
6. drag the sheet header back into the creative tab strip to put the sheet away;
7. drag its tab back onto the desk to tear it out again;
8. reload without losing the sheet document, revision identity or world placement.

Character and References use the same SheetDocument runtime while preserving their existing stable world object IDs.

## Gesture ownership

Nested creative surfaces have explicit gesture precedence:

- a sheet canvas owns ordinary left-drag drawing;
- Space / middle-mouse owns world panning even when the pointer starts over a sheet canvas;
- the sheet title owns title click / double-click interaction;
- the remaining sheet header owns world-sheet dragging.

`creative-sheets-gestures.js` reserves title pointer-down propagation without cancelling the pointer default. This prevents the first click of a native double-click from being captured as a header drag while preserving the title's actual `dblclick` event.

## Partner context

The Partner sees bounded summaries, not raw stroke payloads. A sheet summary contains only directing-relevant identity/state such as:

- sheet ID;
- title;
- kind;
- current revision ID;
- stroke count;
- unsynced status.

Full point arrays remain out of ordinary Partner context to avoid token/context bloat and accidental reinterpretation of raw artist marks.

## Degraded/offline behavior

If a remote sheet save is unavailable, the visible local drawing is retained and marked unsynced rather than being replaced or silently discarded. The user can continue working locally while the degraded state remains honest.

## Validation

### Deterministic suite

The branch-equivalent product tree passes **148/148 Node tests** locally, including:

- immutable sheet revisions and restore;
- stale-write rejection;
- REST round trips;
- world-object / sheet identity mapping;
- raw drawing and tab-round-trip wiring;
- world navigation from a sheet canvas;
- bounded Partner sheet summaries;
- title gesture ownership.

### Native Chromium evidence available so far

The last GitHub-hosted runner that was successfully allocated for this slice was run `32026340679` before the current Actions billing block. On that run:

- editable-artwork Chromium smoke passed;
- floating-workspace Chromium smoke passed;
- Director Loop Chromium smoke passed;
- Creative Desk Chromium smoke passed;
- the new Creative Sheets smoke successfully created a loose sheet, drew on it, persisted the stroke, and Space-panned from the sheet without adding a stroke;
- it then exposed a real rename interaction conflict: the sheet header captured the first click of a double-click before the title could receive `dblclick`.

That conflict has since been fixed. The corrected title-gesture contract is additionally verified in standalone **native Chromium** with the same native mouse sequence: `dragStarts = 0`, `dblclick = 1`, and the title enters `contenteditable=true`.

### Full five-smoke rerun pending

A complete post-fix GitHub-hosted five-smoke rerun is **not currently available**. GitHub is refusing to allocate any Actions runner for the repository and annotates the job:

> The job was not started because recent account payments have failed or your spending limit needs to be increased.

This is an external CI/billing block, not a test assertion. The permanent `Creative Sheets v1` workflow remains read-only and ready to rerun unchanged once Actions execution is restored. Until that happens, this slice must not be described as fully browser-accepted.

## Permanent acceptance gate

`.github/workflows/creative-sheets.yml` is read-only (`contents: read`) and is configured to run:

- syntax checks, including the sheet gesture module;
- the complete Node suite;
- editable-artwork native Chromium smoke;
- floating-workspace native Chromium smoke;
- Director Loop native Chromium smoke;
- Creative Desk native Chromium smoke;
- Creative Sheets native Chromium smoke covering create, draw, pan, rename, undo, redraw, put-away, tear-out, revision history and full reload persistence.

## Explicit non-goals

Creative Sheets v1 intentionally does not yet provide:

- reference image import / paste / arrangement inside a References sheet;
- image-card transforms or crop controls;
- rich brush engines, pressure curves or erasers;
- free text blocks / sticky notes inside a sheet;
- delete/archive UI for sheet documents;
- arbitrary rotation controls in the artist UI;
- final warm ivory / graphite sketchbook visual design;
- production pose, camera, motion or video generation adapters.

Reference/media cards are the natural next layer because they can now live inside the same revisioned SheetDocument model rather than requiring another ad hoc persistence system.
