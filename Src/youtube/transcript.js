/**
 * Transcript extraction — MAIN world only.
 *
 * The obvious routes are both closed, measured against client 2.20260805.01.00:
 *
 *   1. `captionTracks[].baseUrl` from ytInitialPlayerResponse returns HTTP 200
 *      with a zero-length body. Tried raw, `&fmt=json3`, and `&fmt=json3&tlang=en`.
 *   2. Replaying `/youtubei/v1/get_transcript` with the `getTranscriptEndpoint.params`
 *      harvested from ytInitialData returns 400 FAILED_PRECONDITION. Tried full
 *      ytcfg context and a minimal one, with and without SAPISIDHASH, and with
 *      the params both URL-encoded and decoded. All five identical.
 *
 * So we do not construct the request — we let YouTube make it and take the
 * result, the same principle that made the feedback tokens work. Providers are
 * tried in order of reliability and the winner is reported, so failures are
 * attributable rather than mysterious.
 */

const MAX_PANEL_WAIT_MS = 6000;
const POLL_MS = 150;

/** Free metadata, no request needed. Available even when no transcript is. */
export function readVideoMetadata(win = window) {
  const response = win.ytInitialPlayerResponse;
  const details = response?.videoDetails;
  if (!details) return null;

  const tracks = response.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return {
    videoId: details.videoId,
    title: details.title,
    channelId: details.channelId,
    author: details.author,
    durationSeconds: Number(details.lengthSeconds) || null,
    description: details.shortDescription ?? '',
    keywords: details.keywords ?? [],
    captionLanguages: tracks.map((track) => ({
      code: track.languageCode,
      generated: track.kind === 'asr'
    }))
  };
}

function segmentsFromDom(doc = document) {
  const nodes = doc.querySelectorAll('ytd-transcript-segment-renderer');
  const segments = [];

  for (const node of nodes) {
    // Read the bound payload, never the rendered text: the DOM shows a
    // formatted timestamp, the payload has exact millisecond bounds.
    const data = node.data;
    if (!data) continue;
    const text = data.snippet?.runs?.map((run) => run.text).join('') ?? '';
    if (!text.trim()) continue;
    segments.push({ startMs: Number(data.startMs), endMs: Number(data.endMs), text: text.trim() });
  }
  return segments;
}

/** Parse a captured `/youtubei/v1/get_transcript` response body. */
export function segmentsFromResponse(body) {
  const segments = [];
  const seen = new WeakSet();

  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 40 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const value of node) walk(value, depth + 1);
      return;
    }
    const segment = node.transcriptSegmentRenderer;
    if (segment) {
      const text = segment.snippet?.runs?.map((run) => run.text).join('') ?? '';
      if (text.trim()) {
        segments.push({
          startMs: Number(segment.startMs),
          endMs: Number(segment.endMs),
          text: text.trim()
        });
      }
    }
    for (const key in node) walk(node[key], depth + 1);
  })(body, 0);

  return segments;
}

/**
 * Watch YouTube's own transcript traffic. Patches both fetch and XHR because
 * InnerTube calls go through either depending on the code path.
 */
export function installTranscriptCapture(win = window) {
  if (win.__youfactTranscriptCapture) return win.__youfactTranscriptCapture;

  const store = { body: null, at: 0 };
  const isTranscript = (url) => typeof url === 'string' && url.includes('/youtubei/v1/get_transcript');

  const originalFetch = win.fetch;
  win.fetch = async function patchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url;
    const response = await originalFetch.apply(this, arguments);
    if (isTranscript(url)) {
      response
        .clone()
        .json()
        .then((body) => {
          store.body = body;
          store.at = Date.now();
        })
        .catch(() => {});
    }
    return response;
  };

  const originalOpen = win.XMLHttpRequest.prototype.open;
  const originalSend = win.XMLHttpRequest.prototype.send;
  win.XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__youfactUrl = url;
    return originalOpen.apply(this, arguments);
  };
  win.XMLHttpRequest.prototype.send = function patchedSend() {
    if (isTranscript(this.__youfactUrl)) {
      this.addEventListener('load', () => {
        try {
          store.body = JSON.parse(this.responseText);
          store.at = Date.now();
        } catch {
          /* not JSON; ignore */
        }
      });
    }
    return originalSend.apply(this, arguments);
  };

  win.__youfactTranscriptCapture = store;
  return store;
}

function findTranscriptButton(doc = document) {
  // Text-matched because there is no stable structural handle for this control,
  // and the label is one of the few YouTube strings we can enumerate cheaply.
  // Failure here is recoverable — it just means no transcript for this video.
  const labels = /transcript|transcriptie|transcripción|transcription|abschrift|字幕|расшифровка/i;
  return [...doc.querySelectorAll('button')].find((button) => {
    if (button.hasAttribute('data-youfact-ui')) return false;
    if (button.getBoundingClientRect().width === 0) return false;
    return labels.test(`${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`);
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Try each route in turn. Returns the segments plus which provider produced
 * them, so the caller can report honestly and so we learn which routes survive.
 *
 * @returns {Promise<{segments: Array, source: string, metadata: object|null}>}
 */
export async function extractTranscript({ win = window, doc = document, timeoutMs = MAX_PANEL_WAIT_MS } = {}) {
  const metadata = readVideoMetadata(win);

  // 1. Already rendered — the user opened the panel themselves.
  const rendered = segmentsFromDom(doc);
  if (rendered.length) return { segments: rendered, source: 'panel-dom', metadata };

  // 2. Already captured — YouTube fetched it at some point this page view.
  const captured = win.__youfactTranscriptCapture?.body;
  if (captured) {
    const segments = segmentsFromResponse(captured);
    if (segments.length) return { segments, source: 'intercepted', metadata };
  }

  // 3. Ask YouTube to fetch it, then take whichever route lands first.
  const button = findTranscriptButton(doc);
  if (!button) return { segments: [], source: 'unavailable', metadata };

  button.click();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await wait(POLL_MS);

    const fromDom = segmentsFromDom(doc);
    if (fromDom.length) return { segments: fromDom, source: 'panel-opened', metadata };

    const body = win.__youfactTranscriptCapture?.body;
    if (body) {
      const segments = segmentsFromResponse(body);
      if (segments.length) return { segments, source: 'intercepted-after-open', metadata };
    }
  }

  return { segments: [], source: 'timeout', metadata };
}

/**
 * Collapse caption segments into paragraphs with timestamps.
 *
 * ASR output arrives as ~2 second fragments split mid-sentence, which wrecks
 * claim extraction — a claim routinely straddles four segments. Grouping by a
 * time budget gives the model coherent passages while keeping a timestamp to
 * cite, so every claim can point back at the moment it was made.
 */
export function toPassages(segments, { targetSeconds = 45 } = {}) {
  const passages = [];
  let current = null;

  for (const segment of segments) {
    if (!current) {
      current = { startMs: segment.startMs, endMs: segment.endMs, text: segment.text };
      continue;
    }
    const span = segment.endMs - current.startMs;
    if (span > targetSeconds * 1000) {
      passages.push(current);
      current = { startMs: segment.startMs, endMs: segment.endMs, text: segment.text };
    } else {
      current.endMs = segment.endMs;
      current.text += ` ${segment.text}`;
    }
  }
  if (current) passages.push(current);

  return passages.map((passage, index) => ({
    index,
    startMs: passage.startMs,
    endMs: passage.endMs,
    timestamp: formatTimestamp(passage.startMs),
    text: passage.text.replace(/\s+/g, ' ').trim()
  }));
}

export function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
