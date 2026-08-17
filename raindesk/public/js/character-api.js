/* Character Anchors API extension — loaded after the stable Raindesk API client. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./api.js'));
  else root.RaindeskAPI = factory(root.RaindeskAPI);
})(typeof self !== 'undefined' ? self : this, function (api) {
  'use strict';
  if (!api || typeof api.GET !== 'function' || typeof api.POST !== 'function') return api;

  api.listCharacters = function listCharacters() {
    return api.GET('/api/characters');
  };
  api.upsertCharacter = function upsertCharacter(character) {
    return api.POST('/api/character', character || {});
  };
  api.getShotCharacters = function getShotCharacters(shotId) {
    return api.GET(`/api/character/shot-binding?shotId=${encodeURIComponent(shotId)}`);
  };
  api.setShotCharacters = function setShotCharacters(shotId, characterIds) {
    return api.POST('/api/character/shot-binding', {
      shotId,
      characterIds: Array.isArray(characterIds) ? characterIds : [],
    });
  };
  return api;
});
