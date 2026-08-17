/* Creative Sheets gesture ownership: title interaction outranks sheet/world dragging. */
(function () {
  'use strict';
  document.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const target = event.target && event.target.closest ? event.target.closest('.creative-sheet-title') : null;
    if (!target) return;
    // Do not cancel the pointer default: click/dblclick still belong to the title.
    // Stop only propagation so the sheet header and stage cannot convert the
    // first click of a double-click into a drag/pan gesture.
    event.stopPropagation();
  }, true);
})();
