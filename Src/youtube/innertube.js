/**
 * Minimal InnerTube client for the endpoints YouFact actually needs.
 *
 * The client config (api key, client version, request context) lives on the
 * page's `ytcfg` global, which is only reachable from the MAIN world. The
 * harvester reads it there and ships it across the bridge; everything here
 * takes it as an argument rather than reaching for a global.
 */

import { buildAuthHeader, ORIGIN } from './auth.js';

/** Read `ytcfg`. MAIN world only — returns null from an isolated content script. */
export function readClientConfig(win = window) {
  const cfg = win.ytcfg?.data_;
  if (!cfg?.INNERTUBE_API_KEY) return null;

  return {
    apiKey: cfg.INNERTUBE_API_KEY,
    clientVersion: cfg.INNERTUBE_CLIENT_VERSION,
    context: cfg.INNERTUBE_CONTEXT,
    loggedIn: Boolean(cfg.LOGGED_IN)
  };
}

/**
 * Submit feedback tokens. One token per action; the API accepts a batch.
 *
 * A 200 alone does not mean success — YouTube reports per-token results in
 * `feedbackResponses[].isProcessed`, so both are checked.
 *
 * @returns {Promise<{ok: boolean, status: number, processed: boolean, body: object|null}>}
 */
export async function sendFeedback({ clientConfig, feedbackTokens, fetchImpl = fetch }) {
  if (!clientConfig?.apiKey) throw new Error('missing InnerTube client config');
  if (!feedbackTokens?.length) throw new Error('no feedback tokens supplied');

  const url = `${ORIGIN}/youtubei/v1/feedback?key=${encodeURIComponent(clientConfig.apiKey)}&prettyPrint=false`;

  const response = await fetchImpl(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: await buildAuthHeader(),
      'X-Origin': ORIGIN,
      'X-Goog-AuthUser': '0'
    },
    body: JSON.stringify({
      context: clientConfig.context,
      isFeedbackTokenUnencrypted: false,
      shouldMerge: false,
      feedbackTokens
    })
  });

  const body = await response.json().catch(() => null);
  const responses = body?.feedbackResponses;
  const processed =
    Array.isArray(responses) && responses.length > 0
      ? responses.every((entry) => entry.isProcessed === true)
      : false;

  return { ok: response.ok && processed, status: response.status, processed, body };
}
