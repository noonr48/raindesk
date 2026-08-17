# Raindesk Reference Board v1

Reference Board v1 extends revisioned Creative Sheets with immutable reference-image cards. It deliberately reuses the SheetDocument revision model instead of introducing another persistence system.

## Ownership model

- **Workspace** still owns where the References sheet lives in the endless world.
- **SheetDocument** owns reference media and raw drawing content.
- **Blob store** owns immutable PNG bytes addressed by SHA-256.

A reference card therefore stores a blob SHA plus document-relative transform metadata. Moving a sheet cannot rewrite the image or its drawing history, and arranging an image creates a normal immutable SheetDocument revision.

## Sheet media shape

Sheet schema v1 now accepts bounded `media[]` alongside raw `strokes[]`.

Reference Board v1 supports image records with:

- stable media ID;
- immutable local PNG blob SHA;
- x / y position in sheet-document coordinates;
- width / height;
- rotation;
- opacity;
- z-index;
- bounded caption.

The server validates SHA shape, bounds media count to 256 records, rejects unsupported media kinds and duplicate media IDs, and preserves backward compatibility by treating older documents without `media` as `media: []`.

Sheet list/Partner summaries expose only `mediaCount`; they do not expand media records or image bytes into ordinary context.

## Import and paste

The References sheet adds a lightweight `+` control and accepts clipboard image paste when the artist is not editing text.

Images are decoded in-browser, reduced to a maximum dimension of 2048 pixels when necessary, re-encoded as PNG, and stored through the existing immutable blob API. SheetDocument then references the returned SHA.

This keeps reference provenance local and content-addressed rather than retaining transient browser object URLs or external file paths.

## Draw versus arrange

Reference Board has two deliberately separate interaction modes.

### Draw mode

- reference media renders below the transparent sheet stroke canvas;
- normal left-drag drawing remains authoritative raw vector input;
- Space / middle-mouse world navigation continues to work through the Creative Sheets contract.

### Arrange mode

- reference cards move above the drawing canvas;
- the drawing canvas stops accepting pointer input;
- cards can be moved, resized with preserved aspect ratio, rotated in 5° increments, or removed;
- every committed transform creates a SheetDocument revision.

This prevents a drag intended to move a reference from becoming an accidental brush stroke.

## Concurrency contract

Two independent editors can legitimately touch one reference sheet:

1. CreativeDesk edits title/strokes.
2. ReferenceBoard edits `media[]`.

Reference media mutations are serialized per sheet so rapid local move / resize / rotate actions cannot race each other.

`sheet-sync.js` handles the orthogonal stale-write case conservatively. After a `409`, it retries only when:

- the server advanced solely in `media[]` relative to the caller's base revision; **and**
- the incoming stale edit left its own media exactly unchanged from that base revision.

That means a stale drawing/title edit can safely absorb the newest reference arrangement, but a stale media edit is never silently overwritten by another media edit. Any title, stroke, canvas, metadata or competing media conflict remains a real conflict.

## Strict browser journey

`dev/browser-reference-board-smoke.js` is the sixth native-browser acceptance path. It is ready to exercise:

1. focus the built-in References sheet;
2. import a real generated PNG through the browser file input;
3. verify immutable SHA-backed blob retrieval;
4. enter Arrange mode;
5. move the card and persist x/y;
6. resize and persist dimensions;
7. rotate and persist rotation;
8. return to Draw mode;
9. draw a real stroke while CreativeDesk intentionally holds an older sheet revision;
10. require the stale write to merge only the orthogonal media advancement;
11. verify the stroke and arranged card both survive unchanged;
12. require revision history growth;
13. full page reload;
14. verify revision identity, raw stroke, card transform and image DOM all rehydrate.

The smoke uses native Chromium input and `elementFromPoint()` hit testing so clipped or obscured controls are not accepted merely because they exist in the DOM.

## Validation state

The exact Reference Board product tree passes **160/160 deterministic Node tests locally**. This includes:

- SheetDocument media validation and immutable history;
- duplicate-media-ID rejection;
- REST media round trip, bounded summaries and restore;
- conservative sheet-sync concurrency behavior;
- refusal to auto-merge a stale incoming media edit;
- per-sheet ReferenceBoard save serialization;
- import/arrange/draw-over/reload smoke contract wiring;
- all inherited Raindesk tests.

A complete GitHub-hosted native-browser run is currently **pending for an external reason**. GitHub Actions is refusing to allocate runners for this repository and reports that recent account payments failed or the spending limit needs to be increased. This prevents both read-only and write-capable workflows from starting; jobs fail before any test step or runner allocation.

The permanent `.github/workflows/reference-board.yml` workflow is read-only (`contents: read`) and is ready to run the full deterministic suite plus all six native Chromium journeys unchanged once Actions execution is restored.

Reference Board v1 must therefore remain a draft/unaccepted browser slice until that runner executes. The 160/160 deterministic result is not a substitute for the native six-smoke acceptance gate.

## Explicit non-goals

This slice intentionally does not yet provide:

- crop or masking controls;
- multi-select / group transforms;
- explicit bring-forward / send-backward UI;
- opacity slider UI;
- rich caption editing;
- reference URL fetching;
- PDF/video/audio reference cards;
- automatic visual embeddings or Partner inspection of raw media pixels;
- final warm paper / graphite visual redesign;
- production image/motion generation adapters.

The next useful refinement can build richer media-card operations on this same revisioned contract rather than adding another storage layer.
