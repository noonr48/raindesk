/* Raindesk Sheet Sync — preserves orthogonal media edits across revision races. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskSheetSync = mod;
    if (root.RaindeskAPI) mod.install(root.RaindeskAPI, root);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function withoutMedia(document) {
    const copy = clone(document || {});
    delete copy.media;
    return copy;
  }
  function sameExceptMedia(a, b) {
    return JSON.stringify(withoutMedia(a)) === JSON.stringify(withoutMedia(b));
  }
  function mergeCurrentMedia(incoming, current) {
    const merged = clone(incoming || {});
    merged.media = clone(current && current.media || []);
    return merged;
  }
  function dispatchRevision(root, sheetId, revision) {
    if (!root || !root.dispatchEvent || !revision) return;
    let event;
    try { event = new root.CustomEvent('raindesk:sheet-revision', { detail: { sheetId, revision } }); }
    catch (_e) { return; }
    root.dispatchEvent(event);
  }
  function install(api, root = null) {
    if (!api || typeof api.saveSheet !== 'function' || api.__raindeskSheetSyncInstalled) return api;
    const original = api.saveSheet.bind(api);
    api.__raindeskSheetSyncInstalled = true;
    api.saveSheet = async function saveSheetWithOrthogonalMediaMerge(sheetId, document, options = {}) {
      try {
        const result = await original(sheetId, document, options);
        dispatchRevision(root, sheetId, result && result.revision);
        return result;
      } catch (error) {
        if (!error || error.status !== 409 || !options.baseRevisionId || !api.getSheet || !api.getSheetRevision) throw error;
        const [current, base] = await Promise.all([
          api.getSheet(sheetId),
          api.getSheetRevision(sheetId, options.baseRevisionId),
        ]);
        // Retry only when the server advanced *solely* in media[]. Any title,
        // stroke, kind, canvas or meta change remains a real conflict.
        if (!current || !base || !sameExceptMedia(base.document, current.document)) throw error;
        const merged = mergeCurrentMedia(document, current.document);
        const result = await original(sheetId, merged, {
          ...options,
          baseRevisionId: current.revisionId,
          reason: `${options.reason || 'edit sheet'} + merge reference media`,
        });
        dispatchRevision(root, sheetId, result && result.revision);
        return result;
      }
    };
    return api;
  }

  return { clone, withoutMedia, sameExceptMedia, mergeCurrentMedia, install };
});
