# Raindesk Creative Desk v1

Creative Desk v1 begins the transition from a single centred shot canvas to the messy, persistent artistic wall Raindesk is intended to become.

## Coordinate contract

Workspace schema v2 explicitly separates:

- `space: "screen"` — Partner, Layers, Scenes, Beats and other utility panels;
- `space: "world"` — shot sheets, character canvases, reference boards, comic pages, notes and future loose art objects.

Existing workspace schema v1 state migrates safely by object type. World objects never inherit screen-edge docking.

The persistent world viewport is:

```text
{x, y, zoom}
```

`x` / `y` are CSS-pixel pan offsets. `zoom` multiplies the stage's base shot scale. The canvas renderer calculates its fit in CSS pixels first and only converts to device pixels at raster draw time, so drawing/pointer coordinates remain stable across device pixel ratios.

## Artist interaction

Desktop Creative Desk v1 supports:

- mouse-wheel zoom around the cursor;
- Space + left-drag or middle-drag world panning;
- `Wall | Shot | Character | References` creative view tabs;
- clicking a creative tab reveals/focuses its world sheet;
- dragging Character / References tabs onto the desk tears them out at the dropped world location;
- world Character / Reference sheets can be dragged, resized and put away;
- world viewport and sheet transforms persist across reload.

The current shot remains the real editable 1024x1024 artwork surface, but it is now represented by a stable world object (`world_shot_<shotId>`) centred at world origin. Character/reference sheets are sibling world objects rather than screen overlays.

## Partner context

The Partner receives both coordinate spaces separately:

- `workspace` — screen-space utility panels;
- `creativeDesk` — persistent world viewport and creative world objects.

This lets future casual requests such as “put the character sheet beside this shot” target stable world identities rather than guessed DOM pixels.

## Intentional limitations

Creative Desk v1 proves the world/screen architecture; it is not the final visual system yet. Still pending:

- arbitrary number of character/reference/comic/shot canvases;
- live drawing directly inside detached world sheets;
- sheet rotation gestures and grouping;
- world minimap / named anchors;
- true multi-shot wall thumbnails rather than only the active editable shot;
- warm final sketchbook/paper styling;
- Partner-generated spatial arrangements and reference gathering.

The first native acceptance gate must prove viewport zoom/pan, tab tear-out, world-sheet drag, focus, and reload persistence without regressing Director Loop v1.
