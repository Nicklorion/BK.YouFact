/**
 * Blocklist enforcement.
 *
 * Hiding is done with CSS keyed off the `data-youfact-channel` attribute the
 * harvester stamps, rather than by walking the DOM and setting styles on
 * elements. One stylesheet with N rules covers every item that exists now and
 * every item YouTube renders later — infinite scroll, SPA navigation and
 * re-renders all resolve for free, because the rule matches the attribute
 * rather than the node.
 *
 * Only elements also carrying `data-youfact-hideable` are affected. The watch
 * page owner and the currently playing Short are stamped with a channel but not
 * marked hideable, so blocking a channel never blanks the video being watched.
 */

const STYLE_ID = 'youfact-enforcement';

function escapeId(channelId) {
  // Channel ids are [A-Za-z0-9_-] so this is belt and braces, but the value
  // lands inside a CSS attribute selector and must not be able to break out.
  return channelId.replace(/["\\]/g, '\\$&');
}

export function createEnforcer(doc = document) {
  let style = null;

  function ensureStyle() {
    if (style?.isConnected) return style;
    style = doc.getElementById(STYLE_ID);
    if (!style) {
      style = doc.createElement('style');
      style.id = STYLE_ID;
      (doc.head ?? doc.documentElement).append(style);
    }
    return style;
  }

  return {
    /** @param {Iterable<string>} channelIds */
    apply(channelIds) {
      const ids = [...channelIds];
      const sheet = ensureStyle();

      if (ids.length === 0) {
        sheet.textContent = '';
        return 0;
      }

      const selector = ids
        .map((id) => `[data-youfact-hideable][data-youfact-channel="${escapeId(id)}"]`)
        .join(',\n');

      sheet.textContent = `${selector} { display: none !important; }`;
      return ids.length;
    }
  };
}
