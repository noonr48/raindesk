# Stage-6 — DATA MODEL (unchanged canonical, one new client-only shadow)

Canonical: untouched — windows/groups/shelf/viewport/frames persist exactly as Stages 1–5 defined them. Keyboard ops emit the SAME intents pointer gestures emit (window.* spatial/structural, group.activate, group.setFrame…).

Client-only additions (ephemeral, never persisted):
- focusOrder: recency list of frame ids (for close/minimise restore + Ctrl+G pairing).
- lastAnnouncement: announcer region text (aria-live polite).
- keyboardMoveSession: debounce identity so held-arrow repeat coalesces to one spatial PATCH per ~120ms (mirrors resize-debounce pattern).

Grouping: the group FRAME owns focus (active member carries it — matches Stage-4: frame owns presentation).
