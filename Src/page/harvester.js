/**
 * MAIN-world harvester.
 *
 * Runs in the page's own JavaScript context, which is the only place `ytcfg`,
 * `ytInitialData` and element payloads are visible. It reads, never writes, and
 * ships what it finds to the isolated content script.
 *
 * The element selectors below are discovery hints, not the contract. When they
 * go stale the ytInitialData scan still yields tokens, and the resolver itself
 * is shape-based so it survives the layout churn that breaks selectors.
 */

import { describeItem, findFeedbackTokens } from '../youtube/schema.js';
import { readClientConfig } from '../youtube/innertube.js';
import { runCanaries } from '../core/canary.js';
import { MESSAGE, postFromPage } from '../core/bridge.js';

const HOST_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'yt-lockup-view-model'
].join(', ');

const RESCAN_DELAY_MS = 400;

/**
 * Element payloads live in different places per architecture:
 * legacy Polymer renderers expose `.data`; modern view models expose a signal
 * accessor at `rawProps.data` and set `.data` to a symbol.
 */
function payloadOf(element) {
  const data = element.data;
  if (data && typeof data === 'object') return data;

  const raw = element.rawProps?.data;
  if (typeof raw === 'function') {
    try {
      return raw();
    } catch {
      return null;
    }
  }
  return null;
}

function scanDocument() {
  const items = [];
  const icons = new Set();
  const seenChannels = new Set();

  for (const element of document.querySelectorAll(HOST_SELECTORS)) {
    const payload = payloadOf(element);
    if (!payload) continue;

    for (const entry of findFeedbackTokens(payload)) {
      if (entry.icon) icons.add(entry.icon);
    }

    const item = describeItem(payload);
    if (!item.channelId) continue;

    // One entry per channel per scan; the cache keeps only the newest anyway.
    const key = `${item.channelId}:${item.token ? 't' : '-'}`;
    if (seenChannels.has(key)) continue;
    seenChannels.add(key);

    items.push(item);
  }

  return { items, icons: [...icons] };
}

function scanInitialData() {
  const root = window.ytInitialData;
  if (!root) return { items: [], icons: [] };

  const icons = new Set();
  for (const entry of findFeedbackTokens(root)) {
    if (entry.icon) icons.add(entry.icon);
  }
  return { items: [], icons: [...icons] };
}

let rescanTimer = null;
let lastCanarySignature = '';

function publish() {
  const clientConfig = readClientConfig();
  const fromDom = scanDocument();
  const fromInitial = scanInitialData();
  const icons = [...new Set([...fromDom.icons, ...fromInitial.icons])];

  if (fromDom.items.length) {
    postFromPage(MESSAGE.HARVEST, { items: fromDom.items, clientConfig });
  }

  const canaries = runCanaries({ clientConfig, items: fromDom.items, icons });

  // Only report when the health picture actually changes, so a scrolling feed
  // doesn't spam the console.
  const signature = `${canaries.healthy}:${canaries.clientVersion}:${canaries.probes
    .map((probe) => Number(probe.ok))
    .join('')}`;
  if (signature !== lastCanarySignature) {
    lastCanarySignature = signature;
    postFromPage(MESSAGE.CANARY, canaries);
  }
}

function scheduleRescan() {
  if (rescanTimer) return;
  rescanTimer = setTimeout(() => {
    rescanTimer = null;
    publish();
  }, RESCAN_DELAY_MS);
}

function start() {
  publish();

  new MutationObserver(scheduleRescan).observe(document.documentElement, {
    childList: true,
    subtree: true
  });

  // YouTube is a single-page app; navigation replaces content without a reload.
  window.addEventListener('yt-navigate-finish', scheduleRescan);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
