# Stage-6 — RISKS

- **World-space arrow deltas at zoom ≠ 1**: screen-intuitive movement needs WProj inverse (delta_screen / zoom); forgetting yields 4.5× slower moves at MAX_ZOOM. Discriminator: unit test at zoom 0.5 asserts the world rect moved by 16 units for an 8px key delta.
- **Held-key repeat flooding the outbox**: coalesce via move-session debounce (the Stage-5 resize pattern); failing this spams spatial PATCHes. Discriminator: fire 5 rapid keydowns, assert ONE record after flush.
- **Focus restore after close of a GROUPED frame**: the frame disappears for all members — restore must target the next frame, not a hidden member. Discriminator: close a group's active member (real close) → focus lands on a visible frame.
- **Journey keyboard dispatch flakiness**: CDP Input.dispatchKeyEvent vs synthetic KeyboardEvent — use CDP for the leg; keep unit tests on synthetic events.
- **Ctrl+W browser-close hijack**: preventDefault on the desk's keydown only when a frame owns focus; the browser keeps Ctrl+W otherwise. Journey must assert we did NOT leave the page.
- **Regression on pointer paths**: every K-cluster must leave the 475-test suite + journey + matrix green (they cover pointer flows densely).
