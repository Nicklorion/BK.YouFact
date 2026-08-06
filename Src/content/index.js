/**
 * ISOLATED-world content script — the side that decides, persists and renders.
 *
 * Owns chrome.storage, the blocklist, the token cache, the injected UI and the
 * conversation with the service worker. Page state arrives from the MAIN-world
 * harvester over the bridge, because neither world can see both halves.
 *
 * It never sees the API key. Model calls happen in the service worker; this
 * script sends a transcript and gets back a verdict.
 */

import { createTokenCache } from '../core/tokenCache.js';
import { createBlocklist } from '../core/blocklist.js';
import { createCheckStore } from '../core/checkStore.js';
import { createDontRecommend, OUTCOME } from '../core/dontRecommend.js';
import { MESSAGE, listenInContent, postFromContent } from '../core/bridge.js';
import { installStyles } from '../ui/styles.js';
import { createEnforcer } from '../ui/enforce.js';
import { createInjector } from '../ui/inject.js';
import { showUndoToast } from '../ui/toast.js';
import { createFactCheckPill, createPanel, MARKER } from '../ui/factCheck.js';
import { findWatchMount } from '../ui/anchors.js';

/** The user's only chance to take it back — YouTube provides no undo. */
const UNDO_WINDOW_MS = 5000;
const TRANSCRIPT_TIMEOUT_MS = 20000;

const cache = createTokenCache();
const blocklist = createBlocklist();
const checks = createCheckStore();
const enforcer = createEnforcer();

let clientConfig = null;
const transcriptWaiters = [];

const dontRecommend = createDontRecommend({
  cache,
  blocklist,
  getClientConfig: () => clientConfig,
  undoWindowMs: UNDO_WINDOW_MS
});

function syncEnforcement() {
  enforcer.apply(blocklist.all().map((entry) => entry.channelId));
}

function activateBlock(channelId, channelName) {
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

const injector = createInjector({ onActivate: activateBlock });

/** Ask the MAIN world for a transcript. Resolves with whatever it managed to get. */
function requestTranscript() {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const index = transcriptWaiters.indexOf(resolve);
      if (index >= 0) transcriptWaiters.splice(index, 1);
      resolve({ source: 'timeout', passages: [] });
    }, TRANSCRIPT_TIMEOUT_MS);

    transcriptWaiters.push((result) => {
      clearTimeout(timer);
      resolve(result);
    });
    postFromContent(MESSAGE.TRANSCRIPT_REQUEST, {});
  });
}

const FAIL_MESSAGE = {
  'not-configured': 'add an API key in settings',
  'no-transcript': 'no transcript available',
  'no-claims': 'no checkable claims found',
  'provider-error': 'provider error'
};

/** Stream a check through the service worker, reporting progress to the pill. */
function runCheck(payload, onProgress) {
  return new Promise((resolve) => {
    const port = chrome.runtime.connect({ name: 'youfact-check' });
    port.onMessage.addListener((message) => {
      if (message.stage === 'done') {
        port.disconnect();
        resolve({ ok: true, record: message.record });
        return;
      }
      if (message.stage === 'failed') {
        port.disconnect();
        resolve({ ok: false, reason: message.reason, message: message.message });
        return;
      }
      onProgress(message);
    });
    port.onDisconnect.addListener(() => resolve({ ok: false, reason: 'disconnected' }));
    port.postMessage({ type: 'run', payload });
  });
}

let watchPill = null;
let openPanel = null;

function closePanel() {
  openPanel?.remove();
  openPanel = null;
}

function showPanel(videoId, channelId) {
  closePanel();
  const record = checks.getVideo(videoId);
  if (!record) return;

  const metadata = document.querySelector('ytd-watch-metadata');
  if (!metadata) return;

  openPanel = createPanel({
    record,
    channel: checks.getChannel(channelId),
    onClose: closePanel,
    onRecheck: () => {
      closePanel();
      void startCheck(videoId, channelId, { force: true });
    }
  });
  metadata.append(openPanel);
}

async function startCheck(videoId, channelId, { force = false } = {}) {
  if (!force && checks.getVideo(videoId)) {
    showPanel(videoId, channelId);
    return;
  }

  watchPill?.setState({ kind: 'running', stage: 'extract' });

  const transcript = await requestTranscript();
  if (!transcript.passages?.length) {
    watchPill?.setState({ kind: 'error', message: 'no transcript' });
    return;
  }

  const result = await runCheck(
    {
      videoId,
      channelId,
      metadata: transcript.metadata,
      passages: transcript.passages
    },
    (progress) =>
      watchPill?.setState({ kind: 'running', stage: progress.stage, claimCount: progress.claimCount })
  );

  if (!result.ok) {
    watchPill?.setState({ kind: 'error', message: FAIL_MESSAGE[result.reason] ?? result.reason });
    return;
  }

  await checks.save(result.record);
  refreshPill(videoId, channelId);
  showPanel(videoId, channelId);
}

function refreshPill(videoId, channelId) {
  watchPill?.setState({
    kind: 'idle',
    video: checks.getVideo(videoId),
    channel: checks.getChannel(channelId)
  });
}

/** The pill lives beside Like and Share, where there is room for a real label. */
function mountFactCheck() {
  const mount = findWatchMount();
  if (!mount) return;

  const existing = mount.container.querySelector(`:scope > [${MARKER}="factcheck"]`);
  const videoId = new URLSearchParams(location.search).get('v');
  if (!videoId) return;

  if (existing) {
    if (existing.dataset.videoId === videoId) return;
    existing.remove();
    closePanel();
  }

  const pill = createFactCheckPill({
    onActivate: () => void startCheck(videoId, mount.channelId),
    onOpen: () => (openPanel ? closePanel() : showPanel(videoId, mount.channelId))
  });
  pill.node.dataset.videoId = videoId;
  mount.container.append(pill.node);
  watchPill = pill;
  refreshPill(videoId, mount.channelId);
}

listenInContent((type, payload) => {
  if (type === MESSAGE.HARVEST) {
    if (payload?.clientConfig) clientConfig = payload.clientConfig;
    cache.rememberAll(payload?.items);
    mountFactCheck();
    return;
  }

  if (type === MESSAGE.TRANSCRIPT_RESULT) {
    const waiter = transcriptWaiters.shift();
    waiter?.(payload);
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

void Promise.all([cache.load(), blocklist.load(), checks.load()]).then(() => {
  syncEnforcement();
  injector.refresh();
  mountFactCheck();
});

/** Manual driving surface — see README. */
globalThis.__youfact = {
  cache,
  blocklist,
  checks,
  dontRecommend,
  injector,
  OUTCOME,
  requestTranscript,
  clientConfig: () => clientConfig,
  stats: () => ({
    cachedChannels: cache.size(),
    blockedChannels: blocklist.size(),
    checkedVideos: checks.size(),
    pending: dontRecommend.pendingCount(),
    expiry: cache.expiryStats()
  })
};
