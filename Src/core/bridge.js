/**
 * Message bridge between the two content-script worlds.
 *
 * The split is forced by the platform, not by preference:
 *   MAIN world     sees ytcfg, ytInitialData and element payloads; no chrome.* APIs.
 *   ISOLATED world sees chrome.storage and the extension runtime; no page globals.
 *
 * So the harvester runs in MAIN and posts what it finds; everything that needs
 * to persist or decide runs in ISOLATED.
 *
 * Feedback tokens are the page's own data, already present in the DOM, so
 * putting them on `window.postMessage` leaks nothing the page didn't already
 * have. Messages are still namespaced and same-window-checked so unrelated page
 * traffic can't be mistaken for ours.
 */

export const NAMESPACE = 'bk.youfact';

export const MESSAGE = Object.freeze({
  HARVEST: 'harvest',
  CANARY: 'canary',
  /** ISOLATED -> MAIN: extract a transcript for the current video. */
  TRANSCRIPT_REQUEST: 'transcript-request',
  /** MAIN -> ISOLATED: the result, including which provider produced it. */
  TRANSCRIPT_RESULT: 'transcript-result'
});

/** MAIN -> ISOLATED. */
export function postFromPage(type, payload) {
  window.postMessage({ namespace: NAMESPACE, type, payload, from: 'page' }, window.location.origin);
}

/** ISOLATED -> MAIN. */
export function postFromContent(type, payload) {
  window.postMessage({ namespace: NAMESPACE, type, payload, from: 'content' }, window.location.origin);
}

/**
 * MAIN <- ISOLATED. Returns an unsubscribe function.
 * @param {(type: string, payload: unknown) => void} handler
 */
export function listenInPage(handler) {
  const onMessage = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.namespace !== NAMESPACE || data.from !== 'content') return;
    handler(data.type, data.payload);
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}

/**
 * ISOLATED <- MAIN. Returns an unsubscribe function.
 * @param {(type: string, payload: unknown) => void} handler
 */
export function listenInContent(handler) {
  const onMessage = (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.namespace !== NAMESPACE || data.from !== 'page') return;
    handler(data.type, data.payload);
  };

  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
