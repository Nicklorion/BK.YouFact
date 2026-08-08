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
 */

import { buildAuthHeader, ORIGIN } from './auth.js';
import { segmentsFromPayload } from './transcript.js';

const PANEL_ID = 'PAmodern_transcript_view';

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
 * Runs in the ISOLATED content script: it shares the document's cookie jar so
 * the request is authenticated, and `document.cookie` still yields SAPISID for
 * signing. That means transcripts no longer depend on the MAIN world or on any
 * UI being present.
 *
 * @param {{videoId: string, clientConfig: object, fetchImpl?: typeof fetch,
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
  if (!clientConfig?.context) {
    return { ok: false, segments: [], status: 0, reason: 'no-client-config' };
  }

  const visitorData = clientConfig.context?.client?.visitorData ?? '';

  let response;
  try {
    response = await fetchImpl(`${ORIGIN}/youtubei/v1/get_panel?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        authorization: await buildAuth(),
        'x-origin': ORIGIN,
        'x-goog-authuser': '0',
        'x-goog-visitor-id': visitorData,
        'x-youtube-client-name': '1',
        'x-youtube-client-version': clientConfig.clientVersion
      },
      body: JSON.stringify({
        context: clientConfig.context,
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
