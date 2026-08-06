/**
 * ISOLATED-world content script — the side that decides, persists and renders.
 *
 * Owns chrome.storage, the blocklist, the token cache, the outbound InnerTube
 * call and the injected UI. Receives page state from the MAIN-world harvester
 * over the bridge, because neither world can see both halves.
 *
 * The fetch runs here rather than in the page: content scripts share the
 * document's cookie jar, so same-origin requests carry YouTube's cookies and
 * `document.cookie` still yields SAPISID for signing.
 */

import { createTokenCache } from '../core/tokenCache.js';
import { createBlocklist } from '../core/blocklist.js';
import { createDontRecommend, OUTCOME } from '../core/dontRecommend.js';
import { MESSAGE, listenInContent } from '../core/bridge.js';
import { installStyles } from '../ui/styles.js';
import { createEnforcer } from '../ui/enforce.js';
import { createInjector } from '../ui/inject.js';
import { showUndoToast } from '../ui/toast.js';

/** The user's only chance to take it back — YouTube provides no undo. */
const UNDO_WINDOW_MS = 5000;

const cache = createTokenCache();
const blocklist = createBlocklist();
const enforcer = createEnforcer();

let clientConfig = null;

const dontRecommend = createDontRecommend({
  cache,
  blocklist,
  getClientConfig: () => clientConfig,
  undoWindowMs: UNDO_WINDOW_MS
});

function syncEnforcement() {
  enforcer.apply(blocklist.all().map((entry) => entry.channelId));
}

function activate(channelId, channelName) {
  const { undo } = dontRecommend.request(channelId, { name: channelName });
  syncEnforcement();

  showUndoToast({
    message: `No longer recommending ${channelName ?? 'this channel'}`,
    windowMs: UNDO_WINDOW_MS,
    onUndo: async () => {
      await undo();
      syncEnforcement();
      injector.refresh();
    }
  });
}

const injector = createInjector({ onActivate: activate });

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

installStyles();
injector.start();

// Harvest messages can arrive before storage resolves; both stores are written
// so that in-memory state is never displaced by an older persisted copy.
void Promise.all([cache.load(), blocklist.load()]).then(() => {
  syncEnforcement();
  injector.refresh();
});

/**
 * Manual driving surface, useful while the fact-check UI is still unbuilt.
 * Reachable from devtools by switching the console context to the extension's
 * isolated world — see README.
 */
globalThis.__youfact = {
  cache,
  blocklist,
  dontRecommend,
  injector,
  OUTCOME,
  syncEnforcement,
  clientConfig: () => clientConfig,
  stats: () => ({
    cachedChannels: cache.size(),
    blockedChannels: blocklist.size(),
    pending: dontRecommend.pendingCount(),
    expiry: cache.expiryStats()
  })
};
