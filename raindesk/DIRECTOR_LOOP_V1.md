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

The permanent read-only Director Loop workflow runs:

- the full Node suite;
- editable-artwork Chromium smoke;
- floating-workspace Chromium smoke;
- Director Loop native Chromium smoke covering beat creation, beat-scoped DIRECT, frame capture, constraints, reorder, and full reload persistence.

This slice intentionally does not yet connect a high-control image/motion adapter. It proves the creative directing language before production models are allowed underneath it.
