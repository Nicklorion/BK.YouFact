/**
 * Direct transcript fetch via /youtubei/v1/get_panel.
 *
 * This supersedes the click-the-button route. YouTube retired get_transcript —
 * which is why replaying it returned FAILED_PRECONDITION no matter what context
 * or auth we sent — and the web client now calls get_panel instead.
 *
 * Captured from YouTube's own traffic (client 2.20260807.00.00). The request
 * body is gzip-compressed by the page, but the server accepts it uncompressed,
 * and the query string carries only prettyPrint=false — no API key.
 *
 * The decisive property is that `params` is constructible rather than
 * harvestable. It decodes to:
 *
 *   field 149 (length-delimited) {
 *     field 1 (string) : videoId
 *     field 3 (varint) : 2
 *   }
 *
 * So a transcript can be pulled for ANY video id without ever loading its page.
 * Verified: fetching a different video's transcript from an unrelated watch page
 * returned 85 segments with correct text.
 *
 * What the endpoint actually requires was measured against client
 * 2.20260811.01.00, one video, four variants, all returning 198 segments:
 *
 *   full ytcfg context + cookies + SAPISIDHASH   200, 198 segments
 *   full ytcfg context, no cookies, no auth      200, 198 segments
 *   hand-built minimal context, no cookies       200, 198 segments
 *   minimal context with a year-old version      200, 198 segments
 *
 * So it needs the video id and nothing else. Every other input is an
 * optimisation, and treating any of them as mandatory turns a working route
 * into a dead one for anyone signed out or running restrictive cookie
 * settings. They are all sent when available and never required.
 */

import { buildAuthHeader, ORIGIN } from './auth.js';
import { segmentsFromPayload } from './transcript.js';

const PANEL_ID = 'PAmodern_transcript_view';

/**
 * Used when `ytcfg` never arrived. The version is a floor, not a claim about
 * what is live — the server accepted a version a year stale, so this only has
 * to parse.
 */
const FALLBACK_CONTEXT = Object.freeze({
  client: Object.freeze({ clientName: 'WEB', clientVersion: '2.20260811.01.00', hl: 'en', gl: 'US' })
});

/** Minimal protobuf varint — ids are short, so lengths never exceed one byte in practice. */
function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return bytes;
}

/**
 * @param {string} videoId
 * @returns {string} base64 params blob, byte-identical to what YouTube sends
 */
export function buildTranscriptParams(videoId) {
  const id = [...videoId].map((char) => char.charCodeAt(0));
  // field 1, wire type 2 (string) = videoId; field 3, varint = 2
  const inner = [0x0a, ...varint(id.length), ...id, 0x18, 0x02];
  // field 149, wire type 2 = the wrapper
  const bytes = [0xaa, 0x09, ...varint(inner.length), ...inner];
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Fetch a transcript for any video id.
 *
 * Runs in the ISOLATED content script, so transcripts depend on neither the
 * MAIN world nor any UI being present. `clientConfig` is used when the
 * harvester has shipped it and substituted when it has not — the only input
 * that actually matters is the video id.
 *
 * @param {{videoId: string, clientConfig?: object|null, fetchImpl?: typeof fetch,
 *          buildAuth?: () => Promise<string>}} options
 * @returns {Promise<{ok: boolean, segments: Array, status: number, reason?: string}>}
 */
export async function fetchTranscript({
  videoId,
  clientConfig,
  fetchImpl = fetch,
  buildAuth = buildAuthHeader
}) {
  if (!videoId) return { ok: false, segments: [], status: 0, reason: 'no-video-id' };

  const context = clientConfig?.context ?? FALLBACK_CONTEXT;
  const visitorData = context.client?.visitorData;
  const clientVersion = clientConfig?.clientVersion ?? FALLBACK_CONTEXT.client.clientVersion;

  // Signing is an optimisation, not a requirement: the endpoint answers
  // unauthenticated. `buildAuth` throws when there is no SAPISID cookie — for
  // a signed-out user, or a browser partitioning Google's cookies — and
  // letting that throw propagate would fail a request that would have
  // succeeded.
  let authorization = null;
  try {
    authorization = await buildAuth();
  } catch {
    /* not signed in; the request does not need it */
  }

  const headers = {
    'content-type': 'application/json',
    'x-origin': ORIGIN,
    'x-youtube-client-name': '1',
    'x-youtube-client-version': clientVersion
  };
  // Sending an empty visitor id or a null authorization is worse than sending
  // neither — omit rather than assert something untrue about the caller.
  if (authorization) {
    headers.authorization = authorization;
    headers['x-goog-authuser'] = '0';
  }
  if (visitorData) headers['x-goog-visitor-id'] = visitorData;

  let response;
  try {
    response = await fetchImpl(`${ORIGIN}/youtubei/v1/get_panel?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({
        context,
        panelId: PANEL_ID,
        params: buildTranscriptParams(videoId)
      })
    });
  } catch (error) {
    return { ok: false, segments: [], status: 0, reason: 'network', message: String(error?.message ?? error) };
  }

  if (!response.ok) {
    return { ok: false, segments: [], status: response.status, reason: 'http-error' };
  }

  const body = await response.json().catch(() => null);
  if (!body) return { ok: false, segments: [], status: response.status, reason: 'unparseable' };

  const segments = segmentsFromPayload(body);
  if (!segments.length) {
    // A 200 with no segments is the normal shape for a video that has no
    // captions at all, so it is reported distinctly rather than as a failure.
    return { ok: false, segments: [], status: response.status, reason: 'no-captions' };
  }

  return { ok: true, segments, status: response.status };
}
