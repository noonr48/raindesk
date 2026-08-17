/* Raindesk Shot Context — tiny bridge from the active-shot title to stable browser context. */
(function (root) {
  'use strict';
  if (!root || !root.document || root.__raindeskShotContextInstalled) return;
  root.__raindeskShotContextInstalled = true;
  const document = root.document;
  function parseShotId() {
    const title = document.getElementById('shotTitle');
    const first = String(title && title.textContent || '').split('·')[0].trim();
    return /^[A-Za-z0-9_-]{1,96}$/.test(first) && first !== 'raindesk' ? first : '';
  }
  let last = null;
  function publish() {
    const shotId = parseShotId();
    document.documentElement.dataset.raindeskShotId = shotId;
    if (shotId === last) return;
    last = shotId;
    try { root.dispatchEvent(new root.CustomEvent('raindesk:shot-change', { detail: { shotId: shotId || null } })); }
    catch (_e) { /* data attribute remains available */ }
  }
  const title = document.getElementById('shotTitle');
  if (title && root.MutationObserver) {
    const observer = new root.MutationObserver(publish);
    observer.observe(title, { childList: true, characterData: true, subtree: true });
    root.__raindeskShotContextObserver = observer;
  }
  publish();
})(typeof window !== 'undefined' ? window : this);
