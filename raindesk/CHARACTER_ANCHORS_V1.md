# Raindesk Character Anchors v1

Character Anchors v1 gives the detachable Character sheet a small amount of durable identity authority without turning it into a character-inspector form.

## Product rule

**Shot presence and visual identity authority are different things.**

A character may belong to a rough shot while their design is still exploratory. Pinning a look is optional and reversible. The artist can therefore block story, acting and camera before finalising visual identity.

## Character registry

The local registry stores stable character records with:

- stable character ID;
- display name + aliases;
- canonical Character sheet ID;
- optional immutable visual anchors backed by blob SHA-256;
- lightweight explicit identity rules;
- pinned/unpinned (`locked` internally) identity authority;
- per-shot cast bindings.

A pinned identity requires at least one immutable image anchor. A shot binding does **not** require a pinned identity.

## Character sheet → visual anchors

Character sheets reuse Reference Board image cards. When the artist chooses to keep the current Character sheet as the character's look, the current immutable image-card SHAs become the explicit authority.

The authority does not silently follow future edits:

- current sheet still matches pinned anchors → pinned/fresh;
- images added/removed/replaced → pin becomes stale;
- artist must explicitly refresh it;
- clicking a fresh pin unpins the look again;
- if all current images are removed, the old pin can still be released rather than trapping the artist.

This makes visual continuity deliberate while keeping exploration reversible.

## Shot presence

The Character sheet has a separate shot-presence control. It can add/remove the character from the active shot whether or not the visual design is pinned.

Raindesk publishes a stable `raindeskShotId` plus `raindesk:shot-change` event. Character controls refresh against the new shot rather than inferring stale state from a previous window layout.

## Partner semantics

Bound character context answers **who is in the shot**.

- `locked=false`: character presence is real, visual identity remains provisional.
- `locked=true`: listed anchors + explicit identity rules are the artist's current identity authority.

Anchor SHA values are asset references only. The Partner prompt explicitly forbids pretending the image was visually inspected unless a vision/tool stage actually inspected it.

Character context is bounded. When one character contains many anchors/rules, nested evidence is pruned before active directing context is sacrificed, while retaining the bound character and a minimum useful anchor set.

## Native acceptance journey

`dev/browser-character-anchors-smoke.js` is the seventh strict browser path. It is ready to prove:

1. open Character sheet;
2. bind the unlocked/exploratory character to the active shot;
3. import a character image as an immutable local blob;
4. pin that current look;
5. verify the bound shot now receives pinned identity authority;
6. unpin the fresh look;
7. repin it;
8. add a second character image;
9. verify the existing pin becomes visibly stale and does not silently change;
10. explicitly refresh the pin;
11. verify the shot binding exposes the refreshed anchors;
12. reload;
13. verify character identity authority + shot membership rehydrate.

## Validation state

The exact scoped Character Anchors product tree passes **174/174 deterministic Node tests locally**.

GitHub Actions is currently refusing runner allocation for this repository due to the account billing/spending-limit state. Therefore the native seven-smoke acceptance run is configured but externally pending. This slice must remain draft until that read-only workflow can execute unchanged.

## Non-goals

- no automatic face/identity model invocation yet;
- no assumption that an anchor SHA means the Partner visually saw that image;
- no technical character-property form;
- no rigid requirement to finalise a design before storyboarding;
- no per-shot costume/injury/emotion continuity model yet;
- no final warm sketchbook visual styling yet.
