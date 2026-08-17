/* Raindesk Character Anchors v1 — explicit identity authority from character-sheet media. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else {
    root.RaindeskCharacterAnchors = mod;
    if (root.document && root.RaindeskAPI) mod.autoStart(root, root.RaindeskAPI);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function cleanPart(value) { return String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 72); }
  function characterIdForSheet(sheetId) {
    if (sheetId === 'sheet_character_primary') return 'character_primary';
    const tail = cleanPart(String(sheetId || '').replace(/^sheet_/, ''));
    return tail ? `character_${tail}` : null;
  }
  function displayName(document, id) {
    const title = String(document && document.title || '').trim();
    if (title && title.toLowerCase() !== 'character') return title.slice(0, 200);
    return id === 'character_primary' ? 'Primary character' : (title || id);
  }
  function anchorRecordsFromMedia(sheetId, media) {
    return (Array.isArray(media) ? media : []).filter((item) => item && item.kind === 'image' && /^[a-f0-9]{64}$/i.test(item.sha || '')).map((item, index) => ({
      id: `anchor_${cleanPart(item.id) || index}`,
      sha: String(item.sha).toLowerCase(),
      sheetId,
      mediaId: String(item.id || '').slice(0, 128) || null,
      view: 'other',
      label: String(item.caption || '').slice(0, 160),
    }));
  }
  function sameAnchorSet(character, document) {
    if (!character || !character.locked) return false;
    const current = anchorRecordsFromMedia(character.canonicalSheetId, document && document.media).map((a) => a.sha).sort();
    const locked = (character.anchors || []).map((a) => String(a.sha || '')).filter(Boolean).sort();
    return current.length > 0 && JSON.stringify(current) === JSON.stringify(locked);
  }
  function currentShotId(document) {
    const published = document && document.documentElement && document.documentElement.dataset
      ? String(document.documentElement.dataset.raindeskShotId || '').trim() : '';
    if (/^[A-Za-z0-9_-]{1,96}$/.test(published)) return published;
    const title = document && document.getElementById && document.getElementById('shotTitle');
    const first = String(title && title.textContent || '').split('·')[0].trim();
    return /^[A-Za-z0-9_-]{1,96}$/.test(first) ? first : null;
  }

  function CharacterAnchors(opts = {}) {
    const root = opts.root || (typeof window !== 'undefined' ? window : null);
    const document = opts.document || (root && root.document);
    const api = opts.api;
    const records = new Map();
    const mounts = new Map();
    let observer = null; let scanTimer = null;
    const refreshAll = () => Promise.all(Array.from(mounts.keys()).map((sheetId) => refreshMount(sheetId).catch(() => null)));

    function sheetIdForElement(el) {
      const worldId = el && el.dataset && el.dataset.worldId; if (!worldId || !document) return null;
      for (const tab of document.querySelectorAll('[data-creative-target][data-sheet-id]')) {
        if (tab.dataset.creativeTarget === worldId) return tab.dataset.sheetId || null;
      }
      return worldId === 'world_character_primary' ? 'sheet_character_primary' : null;
    }
    async function loadRecords() {
      if (!api || !api.listCharacters) return;
      try {
        const result = await api.listCharacters(); records.clear();
        for (const character of result.characters || []) records.set(character.id, character);
      } catch (_e) { /* identity UI remains usable offline as a visual sheet */ }
    }
    async function ensureRecord(sheetId, revision) {
      const id = characterIdForSheet(sheetId); if (!id) return null;
      let record = records.get(id) || null;
      if (!record && api && api.upsertCharacter) {
        try {
          const result = await api.upsertCharacter({ id, name: displayName(revision.document, id), canonicalSheetId: sheetId, anchors: [], locked: false });
          record = result && result.character; if (record) records.set(id, record);
        } catch (_e) { /* server unavailable */ }
      }
      return record;
    }
    async function refreshMount(sheetId) {
      const mount = mounts.get(sheetId); if (!mount || !api || !api.getSheet) return;
      let revision; try { revision = await api.getSheet(sheetId); } catch (_e) { return; }
      if (!revision.document || revision.document.kind !== 'character') return;
      const id = characterIdForSheet(sheetId); const record = records.get(id) || await ensureRecord(sheetId, revision);
      const anchors = anchorRecordsFromMedia(sheetId, revision.document.media);
      const fresh = sameAnchorSet(record, revision.document);
      mount.lock.disabled = anchors.length === 0 && !(record && record.locked);
      mount.lock.textContent = record && record.locked ? (fresh ? '◆' : '◆*') : '◇';
      mount.lock.classList.toggle('locked', Boolean(record && record.locked));
      mount.lock.classList.toggle('stale', Boolean(record && record.locked && !fresh));
      mount.lock.title = record && record.locked
        ? (fresh ? 'current character look is pinned — click to unpin it'
          : (anchors.length ? 'character sheet changed — update the pinned look' : 'pinned images were removed — click to unpin the old look'))
        : (anchors.length ? 'keep these images as the character’s current look' : 'add character images before pinning a look');
      const shotId = currentShotId(document); let bound = false;
      if (shotId && api.getShotCharacters) {
        try { const ctx = await api.getShotCharacters(shotId); bound = Array.isArray(ctx.characterIds) && ctx.characterIds.includes(id); } catch (_e) {}
      }
      mount.bind.disabled = !shotId || !record;
      mount.bind.textContent = bound ? '●' : '○';
      mount.bind.classList.toggle('bound', bound);
      mount.bind.title = !shotId ? 'open a shot first'
        : (bound ? `${record ? record.name : id} is in ${shotId} — click to remove` : `put ${record ? record.name : id} in ${shotId}`);
    }
    async function lockIdentity(sheetId) {
      if (!api || !api.getSheet || !api.upsertCharacter) return null;
      const revision = await api.getSheet(sheetId); const id = characterIdForSheet(sheetId); if (!id) return null;
      const anchors = anchorRecordsFromMedia(sheetId, revision.document.media);
      const existing = records.get(id) || null;
      const fresh = sameAnchorSet(existing, revision.document);
      const shouldUnlock = Boolean(existing && existing.locked && (fresh || anchors.length === 0));
      if (!shouldUnlock && !anchors.length) return null;
      const result = await api.upsertCharacter({
        id,
        name: displayName(revision.document, id),
        canonicalSheetId: sheetId,
        anchors: shouldUnlock ? (existing && existing.anchors || []) : anchors,
        locked: !shouldUnlock,
        aliases: existing && existing.aliases,
        identityRules: existing && existing.identityRules,
      });
      if (result && result.character) records.set(id, result.character);
      await refreshMount(sheetId); return result && result.character;
    }
    async function toggleShot(sheetId) {
      if (!api || !api.getShotCharacters || !api.setShotCharacters) return null;
      const shotId = currentShotId(document); const id = characterIdForSheet(sheetId); if (!shotId || !id) return null;
      const ctx = await api.getShotCharacters(shotId); const ids = Array.isArray(ctx.characterIds) ? ctx.characterIds.slice() : [];
      const index = ids.indexOf(id); if (index >= 0) ids.splice(index, 1); else ids.push(id);
      const result = await api.setShotCharacters(shotId, ids); await refreshMount(sheetId); return result;
    }
    async function inspect(el) {
      const sheetId = sheetIdForElement(el); if (!sheetId || mounts.has(sheetId) || !api || !api.getSheet) return;
      let revision; try { revision = await api.getSheet(sheetId); } catch (_e) { return; }
      if (!revision.document || revision.document.kind !== 'character') return;
      const actions = el.querySelector('.creative-sheet-actions'); if (!actions) return;
      const lock = document.createElement('button'); lock.type = 'button'; lock.className = 'character-anchor-lock'; lock.textContent = '◇';
      const bind = document.createElement('button'); bind.type = 'button'; bind.className = 'character-shot-bind'; bind.textContent = '○';
      lock.addEventListener('pointerdown', (e) => e.stopPropagation()); bind.addEventListener('pointerdown', (e) => e.stopPropagation());
      lock.addEventListener('click', (e) => { e.stopPropagation(); lockIdentity(sheetId).catch(() => {}); });
      bind.addEventListener('click', (e) => { e.stopPropagation(); toggleShot(sheetId).catch(() => {}); });
      actions.prepend(bind); actions.prepend(lock); mounts.set(sheetId, { el, lock, bind });
      await ensureRecord(sheetId, revision); await refreshMount(sheetId);
    }
    function scan() {
      clearTimeout(scanTimer); scanTimer = setTimeout(() => {
        for (const el of document.querySelectorAll('.creative-sheet[data-world-id]')) inspect(el).catch(() => {});
      }, 0);
    }
    function onSheetRevision(event) {
      const revision = event && event.detail && event.detail.revision;
      if (revision && revision.document && revision.document.kind === 'character') refreshMount(revision.sheetId).catch(() => {});
    }
    function onShotChange() { refreshAll().catch(() => {}); }
    function start() {
      if (!document || !api) return null; loadRecords().then(scan).catch(() => scan());
      observer = new root.MutationObserver(scan); observer.observe(document.body, { childList: true, subtree: true });
      root.addEventListener('raindesk:sheet-revision', onSheetRevision);
      root.addEventListener('raindesk:shot-change', onShotChange);
      return api;
    }
    function destroy() {
      if (observer) observer.disconnect(); clearTimeout(scanTimer);
      if (root) {
        root.removeEventListener('raindesk:sheet-revision', onSheetRevision);
        root.removeEventListener('raindesk:shot-change', onShotChange);
      }
    }
    return { start, destroy, scan, lockIdentity, toggleShot, records };
  }

  function autoStart(root, api) {
    if (root.__raindeskCharacterAnchors) return root.__raindeskCharacterAnchors;
    const value = CharacterAnchors({ root, document: root.document, api }); value.start(); root.__raindeskCharacterAnchors = value; return value;
  }
  return { cleanPart, characterIdForSheet, displayName, anchorRecordsFromMedia, sameAnchorSet, currentShotId, CharacterAnchors, autoStart };
});
