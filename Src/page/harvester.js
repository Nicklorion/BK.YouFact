/**
 * MAIN-world harvester.
 *
 * Runs in the page's own JavaScript context, which is the only place `ytcfg`,
 * `ytInitialData` and element payloads are visible. It reads page state, stamps
 * what it learns onto the DOM, and ships tokens across the bridge.
 *
 * Stamping is how the two worlds share element identity. The isolated content
 * script cannot read `element.data`, but both worlds see the same DOM, so
 * `data-youfact-channel` is the handle it uses to attach controls and to hide
 * blocked channels by CSS.
 *
 * The element selectors below are discovery hints, not the contract. When they
 * go stale the resolver still works on whatever payload it is handed, because
 * it matches by shape rather than by path.
 */

import { describeItem, findFeedbackTokens } from '../youtube/schema.js';
import { readClientConfig } from '../youtube/innertube.js';
import { runCanaries } from '../core/canary.js';
import { MESSAGE, postFromPage } from '../core/bridge.js';

/** Cards in a feed, grid or sidebar — safe to hide when their channel is blocked. */
const ITEM_SELECTORS = [
  'ytd-rich-item-renderer',
  'ytd-video-renderer',
  'ytd-compact-video-renderer',
  'yt-lockup-view-model',
  // Shorts shelves on the home feed use their own lockup, and YouTube has
  // shipped several names for it. Listing the variants is cheaper than being
  // wrong about which one is live.
  'ytm-shorts-lockup-view-model',
  'ytm-shorts-lockup-view-model-v2',
  'shorts-lockup-view-model',
  'ytd-reel-item-renderer'
].join(', ');

/**
 * Elements that identify a channel but must never be hidden: blanking the video
 * the user is currently watching is not what "don't recommend" means.
 */
const CONTEXT_SELECTORS = ['ytd-video-owner-renderer', 'ytd-reel-video-renderer'].join(', ');

const RESCAN_DELAY_MS = 400;

/**
 * Element payloads live in different places per architecture: legacy Polymer
 * renderers expose `.data`; modern view models set `.data` to a symbol and put
 * the payload behind a signal accessor at `rawProps.data`.
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

/** Writes only on change — YouTube recycles renderers, so values can go stale. */
function stamp(element, attribute, value) {
  if (value == null || value === '') {
    if (element.hasAttribute(attribute)) element.removeAttribute(attribute);
    return;
  }
  if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
}

function stampElement(element, item, { hideable }) {
  stamp(element, 'data-youfact-channel', item.channelId);
  stamp(element, 'data-youfact-channel-name', item.channelName);
  stamp(element, 'data-youfact-video', item.videoId);
  if (hideable && !element.hasAttribute('data-youfact-hideable')) {
    element.setAttribute('data-youfact-hideable', '');
  }
}

function scanDocument() {
  const items = [];
  const icons = new Set();
  const seen = new Set();

  const collect = (selector, { hideable }) => {
    for (const element of document.querySelectorAll(selector)) {
      const payload = payloadOf(element);
      if (!payload) continue;

      for (const entry of findFeedbackTokens(payload)) {
        if (entry.icon) icons.add(entry.icon);
      }

      const item = describeItem(payload);
      if (!item.channelId) continue;

      stampElement(element, item, { hideable });

      // One entry per channel per scan; the cache keeps only the newest anyway.
      const key = `${item.channelId}:${item.token ? 't' : '-'}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  };

  collect(ITEM_SELECTORS, { hideable: true });
  collect(CONTEXT_SELECTORS, { hideable: false });

  return { items, icons: [...icons] };
}

function scanInitialData() {
  const root = window.ytInitialData;
  if (!root) return [];

  const icons = new Set();
  for (const entry of findFeedbackTokens(root)) {
    if (entry.icon) icons.add(entry.icon);
  }
  return [...icons];
}

let rescanTimer = null;
let lastCanarySignature = '';

function publish() {
  const clientConfig = readClientConfig();
  const fromDom = scanDocument();
  const icons = [...new Set([...fromDom.icons, ...scanInitialData()])];

  if (fromDom.items.length) {
    postFromPage(MESSAGE.HARVEST, { items: fromDom.items, clientConfig });
  }

  const canaries = runCanaries({ clientConfig, items: fromDom.items, icons });

  // Only report when the health picture changes, so a scrolling feed does not
  // spam the console.
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

  // Attributes are deliberately not observed: stamping would otherwise
  // retrigger the observer that caused it.
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
