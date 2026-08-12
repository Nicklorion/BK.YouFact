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
import { fetchTranscript } from '../youtube/transcriptApi.js';
import { toPassages } from '../youtube/transcript.js';

/** The user's only chance to take it back — YouTube provides no undo. */
const UNDO_WINDOW_MS = 5000;
const TRANSCRIPT_TIMEOUT_MS = 20000;

const cache = createTokenCache();
const blocklist = createBlocklist();
const checks = createCheckStore();
const enforcer = createEnforcer();

let clientConfig = null;
const transcriptWaiters = [];
const metadataWaiters = [];

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

/**
 * Ask the MAIN world for something and wait for its reply.
 * Only the page can read ytInitialPlayerResponse and element payloads.
 */
function askPage(requestType, waiters, fallback, timeoutMs = TRANSCRIPT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const waiter = (result) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      resolve(fallback);
    }, timeoutMs);

    waiters.push(waiter);
    postFromContent(requestType, {});
  });
}

const requestTranscript = () =>
  askPage(MESSAGE.TRANSCRIPT_REQUEST, transcriptWaiters, { source: 'no-response-from-page', passages: [] });

const requestMetadata = () => askPage(MESSAGE.METADATA_REQUEST, metadataWaiters, null, 5000);

const TRANSCRIPT_MESSAGE = {
  'no-captions': 'this video has no captions',
  'button-not-found': 'no transcript button',
  'panel-never-populated': 'transcript did not load',
  'no-response-from-page': 'page script not responding',
  error: 'transcript error'
};

const FAIL_MESSAGE = {
  'not-configured': 'add an API key in settings',
  'no-transcript': 'no transcript available',
  'no-claims': 'no checkable claims found',
  'provider-error': 'provider error',
  disconnected: 'background worker stopped'
};

const STAGE_NAME = {
  extract: 'reading the transcript',
  research: 'researching claims',
  judge: 'weighing evidence'
};

/** The last failure, kept so `__youfact.lastFailure` can explain a dead pill. */
let lastFailure = null;

/**
 * Stream a check through the service worker, reporting progress to the pill.
 *
 * Resolves exactly once. The port can both deliver a verdict and then
 * disconnect, and a disconnect can arrive with no verdict at all, so the
 * settled flag is what keeps the two from racing.
 */
function runCheck(payload, onProgress) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stage = 'extract';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ stage, elapsedMs: Date.now() - startedAt, ...result });
    };

    const port = chrome.runtime.connect({ name: 'youfact-check' });

    port.onMessage.addListener((message) => {
      if (message.stage === 'done') {
        port.disconnect();
        finish({ ok: true, record: message.record });
        return;
      }
      if (message.stage === 'failed') {
        port.disconnect();
        finish({
          ok: false,
          reason: message.reason,
          message: message.message,
          stage: message.failedStage ?? stage
        });
        return;
      }
      // Heartbeats carry the stage they are beating for, so this stays correct
      // through the long silent stretches inside one stage.
      stage = message.stage ?? stage;
      onProgress(message);
    });

    port.onDisconnect.addListener(() => finish({ ok: false, reason: 'disconnected' }));
    port.postMessage({ type: 'run', payload });
  });
}

/**
 * Turn a failure into something a person can act on.
 *
 * "Disconnected" on its own is the least useful thing this UI could say: it
 * names the symptom seen from the content script and nothing about the cause.
 * The stage and elapsed time are what distinguish a torn-down worker from a
 * provider that rejected the request.
 */
function describeFailure(result) {
  const where = STAGE_NAME[result.stage] ?? result.stage;
  const seconds = Math.round((result.elapsedMs ?? 0) / 1000);

  if (result.reason === 'disconnected') {
    return (
      `The background worker stopped while ${where}, ${seconds}s in. ` +
      'Reload the extension; if it keeps happening, check the service worker ' +
      'console at brave://extensions for the real error.'
    );
  }
  if (result.message) return `Failed while ${where} after ${seconds}s — ${result.message}`;
  return `Failed while ${where} after ${seconds}s (${result.reason}).`;
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

/**
 * Try each route in the order it deserves.
 *
 * The direct API call is preferred because it needs no UI, no description
 * expansion and no click, so no layout change can break it. It also does not
 * need the client config or a signed-in session — see transcriptApi.js — so it
 * is tried even when the harvester has told us nothing.
 */
async function acquireTranscript(videoId) {
  const direct = await fetchTranscript({ videoId, clientConfig });
  if (direct.ok) {
    // The API returns words but no idea which video they belong to. Ask the
    // page separately — a model judging claims without the title or channel is
    // judging blind.
    return {
      source: 'get_panel',
      metadata: await requestMetadata(),
      passages: toPassages(direct.segments)
    };
  }

  // A 200 carrying no segments has two causes that are indistinguishable from
  // the response alone: the video genuinely has no captions, or the params
  // schema drifted under us. The player response settles it, and settling it
  // is worth the round trip — otherwise a video with no captions spends twenty
  // seconds driving a panel that cannot populate and then reports the wrong
  // reason for the failure.
  const metadata = await requestMetadata();
  const hasCaptions = (metadata?.captionLanguages?.length ?? 0) > 0;
  if (direct.reason === 'no-captions' && metadata && !hasCaptions) {
    return { source: 'no-captions', metadata, passages: [] };
  }

  console.info('[youfact] direct transcript unavailable, falling back to the panel', direct.reason);
  return requestTranscript();
}

/** The video id of the check currently in flight, or null. */
let runningCheck = null;

async function performCheck(videoId, channelId) {
  // YouTube is a single-page app and `mountFactCheck` replaces the pill on
  // every navigation. Writing to `watchPill` directly would paint this
  // video's progress onto whatever video the user moved on to, so the pill is
  // captured here and written to only while it is still the mounted one.
  const pill = watchPill;
  const setPill = (state) => {
    if (watchPill === pill) pill?.setState(state);
  };

  setPill({ kind: 'running', stage: 'extract' });

  const transcript = await acquireTranscript(videoId);

  if (!transcript.passages?.length) {
    // Report why, not just that. The source tells us which step gave up.
    console.warn('[youfact] transcript unavailable', transcript.source, transcript.diagnostics ?? {});
    lastFailure = { at: Date.now(), videoId, phase: 'transcript', source: transcript.source, diagnostics: transcript.diagnostics ?? null };
    setPill({
      kind: 'error',
      message: TRANSCRIPT_MESSAGE[transcript.source] ?? transcript.source,
      detail: `No transcript: ${transcript.source}. See __youfact.lastFailure for details.`
    });
    return;
  }

  // Heartbeats carry neither count, so both are remembered here rather than
  // flickering out of the label every twenty seconds.
  let claimCount = 0;
  let researched = null;
  const result = await runCheck(
    {
      videoId,
      channelId,
      metadata: transcript.metadata,
      passages: transcript.passages
    },
    (progress) => {
      if (progress.claimCount) claimCount = progress.claimCount;
      if (progress.researched != null) researched = progress.researched;
      if (progress.stage === 'judge') researched = null;
      setPill({
        kind: 'running',
        stage: progress.stage,
        claimCount,
        researched,
        elapsedMs: progress.elapsedMs
      });
    }
  );

  if (!result.ok) {
    const detail = describeFailure(result);
    lastFailure = { at: Date.now(), videoId, phase: 'check', ...result };
    console.error('[youfact]', detail, result);
    setPill({
      kind: 'error',
      message: FAIL_MESSAGE[result.reason] ?? result.reason,
      detail
    });
    return;
  }

  await checks.save(result.record);
  refreshPill(videoId, channelId);
  showPanel(videoId, channelId);
}

async function startCheck(videoId, channelId, { force = false } = {}) {
  if (!force && checks.getVideo(videoId)) {
    showPanel(videoId, channelId);
    return;
  }

  // A check runs for tens of seconds and is billed to the user's own key.
  // Without this guard every further click abandoned the run in flight and
  // started — and paid for — a fresh one, which reads as the pill restarting
  // itself.
  if (runningCheck) {
    console.info(`[youfact] a check is already running for ${runningCheck}; ignoring`);
    return;
  }

  runningCheck = videoId;
  try {
    await performCheck(videoId, channelId);
  } finally {
    runningCheck = null;
  }
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
    transcriptWaiters.shift()?.(payload);
    return;
  }

  if (type === MESSAGE.METADATA_RESULT) {
    metadataWaiters.shift()?.(payload);
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
  /** Why the last check died, including the stage and how long it lasted. */
  get lastFailure() {
    return lastFailure;
  },
  /** The video id of the check in flight, or null. */
  get running() {
    return runningCheck;
  },
  stats: () => ({
    cachedChannels: cache.size(),
    blockedChannels: blocklist.size(),
    checkedVideos: checks.size(),
    pending: dontRecommend.pendingCount(),
    expiry: cache.expiryStats()
  })
};
