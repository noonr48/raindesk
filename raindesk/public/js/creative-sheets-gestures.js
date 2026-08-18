/* Creative Sheets gesture ownership: title interaction outranks sheet/world dragging. */
(function () {
  'use strict';
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target && event.target.closest ? event.target.closest('.creative-sheet-title') : null;
    if (!target) return;
    // Reserve only mid-rename presses: while the title is contenteditable,
    // pointer interaction belongs to text selection. At rest the title must
    // still start ordinary header drags (bc77b18's reservation, narrowed —
    // a stationary dblclick carries no movement, so it never converts into
    // a drag or pan; the head's own guard excludes contenteditable targets).
    if (target.getAttribute('contenteditable') !== 'true') return;
    // Do not cancel the pointer default: click/dblclick still belong to the title.
    // Stop only propagation so the sheet header and stage cannot convert the
    // first click of a double-click into a drag/pan gesture.
    event.stopPropagation();
  }, true);
})();
