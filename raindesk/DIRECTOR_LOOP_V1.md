# Raindesk Director Loop v1

Director Loop v1 is the first end-to-end directing slice built on the artistic-state and floating-workspace foundations.

## Artist-facing contract

The artist can stay in visual/directing language:

1. pin a micro-beat in their own words;
2. select that beat;
3. draw a DIRECT arrow/caption on the art;
4. pin shot start/landing references or beat start/end pose references from the current artwork;
5. mark what must stay (`keep`) and what is intentionally changing (`change`);
6. reorder or temporarily remove beats without deleting their creative history;
7. continue the conversation with the Partner using that same context.

Raw wording and raw marks remain authoritative. Partner enrichment is provisional structure around them.

## Selected Beat interaction

Beat rows remain compact paper-strip-like ordering controls. Selecting a Beat no longer expands that row into a tall technical editor. Its start/end pose references appear in a stable selected-Beat detail strip beneath the list.

This gives the artist two simultaneous scales without losing either:

- **Beat list:** sequence, reorder, rewrite, branch/remove;
- **Selected Beat detail:** start/end pose references and the visual directing material for the moment currently being refined.

Shot-level context is deliberately stable while micro-beats are explored: shot start/landing references and `keep` / `change` boundaries remain fixed above the Beat viewport. Only the Beat list and selected-Beat detail scroll. Focusing a micro-action therefore cannot push the shot's framing or preservation contract out of reach.

Selected-Beat visibility is established synchronously in the same render that publishes a newly added or selected Beat. There is no one-frame state where a Beat exists but its reorder/edit controls are still clipped waiting for a later paint.

## Non-blocking Partner enrichment

Saving a Beat is raw-first and returns immediately. The Partner does not own a global Beat Trail busy state while it interprets that direction.

Partner enrichments run through a serialized background queue. The artist can keep reordering Beats, pinning visual references, drawing DIRECT marks, or adding another idea while the Partner thinks. Frame capture has its own short-lived busy state because it creates immutable artwork provenance; Partner interpretation does not block those local directing actions.

This is an explicit product rule: **the Partner can think in the background, but it must not freeze the desk.**

## Semantic shape

Direction schema v3 adds:

- shot `preserve[]` and `change[]` boundaries;
- beat visual `startFrame` / `endFrame` references;
- beat-scoped semantic annotations;
- editable/reorderable Beat Trail operations;
- existing action/performance/dialogue/camera/contact/sound events and temporal relations.

Camera path endpoints remain **cues**. They are never mislabeled as real visual frames. Real shot/beat frames reference immutable local artwork blobs and retain the source art revision when available.

## Partner behavior

When DIRECT is attached to a selected beat, the Partner enriches that beat rather than creating a duplicate. The Partner receives:

- active beat and its events/relations;
- shot start/landing references;
- keep/change constraints;
- art revision/layers/selection;
- nearby direction marks;
- persistent workspace objects.

`keep` is a preservation boundary. `change` is the intended edit scope. Neither gives the model permission to replace accepted artwork; execution remains behind the existing Watch/Suggest/Act action gate.

## Validation

The selected-Beat and shot-context refactors are promoted only after the full **128-test** Node suite passes.

The permanent read-only Director Loop workflow then runs:

- the full Node suite again;
- editable-artwork Chromium smoke;
- floating-workspace Chromium smoke;
- Director Loop native Chromium smoke covering raw Beat creation, beat-scoped DIRECT, shot/beat frame capture, keep/change constraints, reorder, and full reload persistence.

The native click harness also rejects controls whose click point is clipped or covered by another floating surface, so a DOM element merely existing is not sufficient acceptance evidence.

This slice intentionally does not yet connect a high-control image/motion adapter. It proves the creative directing language before production models are allowed underneath it.
