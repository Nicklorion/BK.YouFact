/**
 * ISOLATED-world content script — the side that decides and persists.
 *
 * Owns chrome.storage, the blocklist, the token cache and the outbound
 * InnerTube call. Receives page state from the MAIN-world harvester over the
 * bridge, because neither world can see both halves.
 *
 * The fetch runs here rather than in the page: content scripts share the
 * document's cookie jar, so same-origin requests carry YouTube's cookies and
 * `document.cookie` still yields SAPISID for signing.
 */

import { createTokenCache } from '../core/tokenCache.js';
import { createBlocklist } from '../core/blocklist.js';
import { createDontRecommend, OUTCOME } from '../core/dontRecommend.js';
import { MESSAGE, listenInContent } from '../core/bridge.js';

const cache = createTokenCache();
const blocklist = createBlocklist();

let clientConfig = null;

const dontRecommend = createDontRecommend({
  cache,
  blocklist,
  getClientConfig: () => clientConfig
});

listenInContent((type, payload) => {
  if (type === MESSAGE.HARVEST) {
    if (payload?.clientConfig) clientConfig = payload.clientConfig;
    cache.rememberAll(payload?.items);
    return;
  }

  if (type === MESSAGE.CANARY) {
    if (!payload?.healthy) {
      console.warn('[youfact] canary failure — degrading to local blocklist', payload);
    } else if (payload.clientDrifted) {
      console.info(
        `[youfact] YouTube client is now ${payload.clientVersion}, ` +
          `probes last verified against ${payload.verifiedAgainst} — still healthy`
      );
    }
  }
});

// A pending request must not be lost to a navigation. YouTube is a single-page
// app, so pagehide is the only reliable end-of-life signal.
window.addEventListener('pagehide', () => {
  void dontRecommend.flush();
  void cache.flush();
});

// Harvest messages can arrive before storage finishes loading; the cache
// tolerates that (writes land in memory and persist on the next flush).
void Promise.all([cache.load(), blocklist.load()]);

/**
 * Manual driving surface until the button UI lands.
 * Reachable from devtools by switching the console context to the extension's
 * isolated world — see README.
 */
globalThis.__youfact = {
  cache,
  blocklist,
  dontRecommend,
  OUTCOME,
  clientConfig: () => clientConfig,
  stats: () => ({
    cachedChannels: cache.size(),
    blockedChannels: blocklist.size(),
    pending: dontRecommend.pendingCount(),
    expiry: cache.expiryStats()
  })
};
