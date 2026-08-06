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

/** "1:02:03" or "4:07" -> milliseconds. */
export function parseTimestamp(label) {
  if (typeof label !== 'string') return null;
  const parts = label.trim().split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds * 1000;
}

/**
 * Segments out of any transcript payload, in either schema.
 *
 * Legacy (`ytd-transcript-segment-renderer`):
 *   transcriptSegmentRenderer.{startMs, endMs, snippet.runs[].text}
 *
 * Modern (`transcript-segment-view-model`, current on 2.20260805.01.00):
 *   macroMarkersPanelItemViewModel.item.timelineItemViewModel
 *     .timestamp                                            "0:06"
 *     .contentItems[].transcriptSegmentViewModel.simpleText
 *
 * The modern schema carries no millisecond bounds at all, only the display
 * timestamp, so start times are parsed from it and each segment's end is
 * inferred from the next one's start.
 */
export function segmentsFromPayload(root) {
  const segments = [];
  const seen = new WeakSet();

  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > 45 || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const value of node) walk(value, depth + 1);
      return;
    }

    const legacy = node.transcriptSegmentRenderer;
    if (legacy) {
      const text = legacy.snippet?.runs?.map((run) => run.text).join('') ?? '';
      if (text.trim()) {
        segments.push({ startMs: Number(legacy.startMs), endMs: Number(legacy.endMs), text: text.trim() });
      }
    }

    const timeline = node.timelineItemViewModel;
    if (timeline) {
      const text = (timeline.contentItems ?? [])
        .map((item) => item.transcriptSegmentViewModel?.simpleText ?? '')
        .join(' ')
        .trim();
      const startMs = parseTimestamp(timeline.timestamp);
      if (text && startMs != null) segments.push({ startMs, endMs: null, text });
    }

    for (const key in node) walk(node[key], depth + 1);
  })(root, 0);

  segments.sort((a, b) => a.startMs - b.startMs);

  // Fill in the ends the modern schema omits. Two segments can share a display
  // timestamp — the label only has second resolution — so the next start is not
  // always greater and a naive fill produces zero-length spans.
  const DEFAULT_SPAN_MS = 5000;
  return segments.map((segment, index) => {
    if (Number.isFinite(segment.endMs) && segment.endMs > segment.startMs) return segment;
    const nextStart = segments[index + 1]?.startMs;
    const endMs =
      Number.isFinite(nextStart) && nextStart > segment.startMs
        ? nextStart
        : segment.startMs + DEFAULT_SPAN_MS;
    return { ...segment, endMs };
  });
}

/**
 * Element payloads live in two places depending on architecture: legacy Polymer
 * renderers expose `.data`; modern view models set `.data` to a symbol and put
 * the payload behind a signal accessor at `rawProps.data`. The transcript panel
 * migrated to the latter, which is what broke reading it.
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
  return raw && typeof raw === 'object' ? raw : null;
}

/** Kept as the published name; both schemas route through the same parser. */
export const segmentsFromResponse = segmentsFromPayload;

function segmentsFromDom(doc = document) {
  // Legacy elements bound their own payload per segment.
  const legacy = [...doc.querySelectorAll('ytd-transcript-segment-renderer')]
    .map((node) => node.data)
    .filter(Boolean);
  if (legacy.length) return segmentsFromPayload(legacy);

  // The modern panel binds the whole transcript to one section list. The
  // individual `timeline-item-view-model` elements carry no payload of their
  // own, so the section list is the only route.
  for (const node of doc.querySelectorAll('yt-section-list-renderer')) {
    const data = payloadOf(node);
    if (!data) continue;
    const segments = segmentsFromPayload(data);
    if (segments.length) return segments;
  }
  return [];
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

const TRANSCRIPT_LABELS =
  /transcript|transcriptie|transcripción|transcrição|transcription|abschrift|trascrizione|字幕|文字起こし|расшифровка|무료 자막/i;

/**
 * The "Show transcript" button lives inside the video description, which loads
 * collapsed. Measured: the button exists in the DOM but has a zero-width box
 * until the description is expanded, so any visibility-filtered search misses
 * it. Expanding first is the difference between finding it and not.
 */
function expandDescription(doc = document) {
  const expand =
    doc.querySelector('ytd-text-inline-expander #expand') ??
    doc.querySelector('tp-yt-paper-button#expand') ??
    doc.querySelector('#description-inline-expander #expand');
  if (!expand) return false;
  if (expand.getBoundingClientRect().width === 0) return false;
  expand.click();
  return true;
}

function findTranscriptButton(doc = document) {
  // Text-matched because this control has no stable structural handle. Failure
  // is recoverable — it just means no transcript for this video.
  const matches = (button) =>
    TRANSCRIPT_LABELS.test(`${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`);

  const buttons = [...doc.querySelectorAll('button')].filter(
    (button) => !button.hasAttribute('data-youfact-ui') && matches(button)
  );

  // Prefer one that is actually laid out; fall back to a hidden match, since
  // clicking it still works and costs nothing to try.
  return buttons.find((button) => button.getBoundingClientRect().width > 0) ?? buttons[0] ?? null;
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
  //    Diagnostics are deliberately specific: "no transcript" is useless when
  //    the real answer is "this video has no captions" or "the button moved".
  const hasCaptions = (metadata?.captionLanguages?.length ?? 0) > 0;

  let button = findTranscriptButton(doc);
  let expanded = false;
  if (!button) {
    expanded = expandDescription(doc);
    if (expanded) {
      // The description animates open; the button is not laid out immediately.
      for (let attempt = 0; attempt < 12 && !button; attempt += 1) {
        await wait(POLL_MS);
        button = findTranscriptButton(doc);
      }
    }
  }

  if (!button) {
    return {
      segments: [],
      source: hasCaptions ? 'button-not-found' : 'no-captions',
      metadata,
      diagnostics: { hasCaptions, expandedDescription: expanded }
    };
  }

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

  return {
    segments: [],
    source: 'panel-never-populated',
    metadata,
    diagnostics: {
      hasCaptions,
      expandedDescription: expanded,
      clickedButton: (button.textContent ?? '').trim().slice(0, 40),
      panelPresent: Boolean(
        doc.querySelector('ytd-transcript-renderer, transcript-segment-view-model, yt-section-list-renderer')
      ),
      capturedResponse: Boolean(win.__youfactTranscriptCapture?.body)
    }
  };
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
