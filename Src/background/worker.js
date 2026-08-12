/**
 * Service worker — the only place the API key is ever read.
 *
 * Content scripts share a document with YouTube, so the key must not live
 * there. The content script sends a transcript and gets back a verdict; it
 * never sees a credential.
 *
 * Progress is streamed over a port because a check takes tens of seconds and a
 * button that sits silent that long reads as broken.
 */

import { loadSettings, isConfigured } from '../core/settings.js';
import { extractClaims, researchClaims, judgeClaims } from '../model/anthropic.js';
import { scoreVideo } from '../core/scoring.js';

const PORT_NAME = 'youfact-check';

/**
 * How often to speak while a stage is thinking.
 *
 * A Manifest V3 service worker is torn down after roughly 30 seconds of
 * inactivity, and an in-flight `fetch` does not count as activity — only
 * events and extension API calls reset that timer. The research stage
 * routinely spends minutes inside a single call with nothing on the wire, so
 * the worker was being collected mid-check: the port dropped, and the content
 * script reported `disconnected` with no idea which stage had died. Talking
 * every 20 seconds keeps the worker alive and doubles as the progress clock
 * the pill shows.
 */
const HEARTBEAT_MS = 20000;

export const STAGE = Object.freeze({
  EXTRACT: 'extract',
  RESEARCH: 'research',
  JUDGE: 'judge',
  DONE: 'done',
  FAILED: 'failed'
});

/**
 * @param {object} port a `chrome.runtime` port, or anything with the same shape
 * @param {object} payload the transcript and metadata to check
 * @param {{heartbeatMs?: number}} options `heartbeatMs` exists so tests do not
 *   have to wait twenty seconds to observe a heartbeat
 */
export async function runCheck(
  port,
  { videoId, channelId, metadata, passages },
  { heartbeatMs = HEARTBEAT_MS } = {}
) {
  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;

  let stage = STAGE.EXTRACT;
  let connected = true;
  port.onDisconnect.addListener(() => {
    connected = false;
  });

  /** Posting to a port whose other end has navigated away throws. */
  const send = (message) => {
    if (!connected) return;
    try {
      port.postMessage(message);
    } catch {
      connected = false;
    }
  };

  const enter = (next, extra = {}) => {
    stage = next;
    send({ stage, elapsedMs: elapsed(), ...extra });
  };

  const heartbeat = setInterval(
    () => send({ stage, heartbeat: true, elapsedMs: elapsed() }),
    heartbeatMs
  );

  // `loadSettings` used to sit outside the try. When it threw, the rejection
  // was swallowed by the `void` at the call site, nothing was ever posted, and
  // the check hung until the worker died — surfacing as `disconnected` rather
  // than as the error it was.
  try {
    const settings = await loadSettings();

    if (!isConfigured(settings)) {
      send({ stage: STAGE.FAILED, reason: 'not-configured' });
      return;
    }
    if (!passages?.length) {
      send({ stage: STAGE.FAILED, reason: 'no-transcript' });
      return;
    }

    const usage = [];

    enter(STAGE.EXTRACT);
    const extracted = await extractClaims(settings, {
      passages,
      metadata,
      maxClaims: settings.maxClaims
    });
    usage.push({ stage: STAGE.EXTRACT, ...extracted.usage });

    if (!extracted.claims.length) {
      send({ stage: STAGE.FAILED, reason: 'no-claims' });
      return;
    }
    enter(STAGE.RESEARCH, { claimCount: extracted.claims.length });

    // Each claim is now its own request, so the stage has real progress to
    // report instead of one long silence.
    const research = await researchClaims(settings, {
      claims: extracted.claims,
      metadata,
      onProgress: (researched, total) =>
        send({
          stage: STAGE.RESEARCH,
          claimCount: total,
          researched,
          elapsedMs: elapsed()
        })
    });
    usage.push({ stage: STAGE.RESEARCH, ...research.usage });

    enter(STAGE.JUDGE, { sourceCount: research.sources.length, claimCount: extracted.claims.length });

    const judged = await judgeClaims(settings, {
      claims: extracted.claims,
      findings: research.findings
    });
    usage.push({ stage: STAGE.JUDGE, ...judged.usage });

    // Stitch verdicts back onto their claims. A claim the judge skipped stays
    // unverified rather than silently vanishing from the count.
    const byIndex = new Map(judged.verdicts.map((verdict) => [verdict.index, verdict]));
    const findingFor = new Map(research.findings.map((finding) => [finding.index, finding]));

    const claims = extracted.claims.map((claim, index) => {
      const verdict = byIndex.get(index);
      const finding = findingFor.get(index);
      const cited = (verdict?.sourceUrls ?? []).map(
        (url) => research.sources.find((source) => source.url === url) ?? { url, title: url }
      );

      return {
        ...claim,
        verdict: verdict?.verdict ?? 'unverified',
        confidence: verdict?.confidence ?? 'low',
        reasoning: verdict?.reasoning ?? 'The judging stage returned no verdict for this claim.',
        sources: cited,
        // What the research actually did, so "no sources" can distinguish
        // "searched and found nothing" from "never looked".
        searches: finding?.searches ?? 0,
        searchErrors: finding?.searchErrors ?? [],
        // Sources the search surfaced that the verdict did not lean on. Worth
        // keeping: an unverified claim with four consulted pages is a
        // different thing from one with none.
        consulted: (finding?.sources ?? []).filter(
          (source) => !cited.some((hit) => hit.url === source.url)
        )
      };
    });

    const record = {
      videoId,
      channelId,
      title: metadata?.title ?? null,
      checkedAt: Date.now(),
      model: settings.model,
      effort: settings.effort,
      thinking: settings.thinking,
      promptVersion: 1,
      claims,
      score: scoreVideo({ claims, framing: judged.framing, sourcing: judged.sourcing }),
      usage
    };

    send({ stage: STAGE.DONE, record });
  } catch (error) {
    // Which stage died matters more than the fact that one did: the same
    // provider error means different things at extract, research and judge.
    send({
      stage: STAGE.FAILED,
      reason: 'provider-error',
      failedStage: stage,
      elapsedMs: elapsed(),
      message: String(error?.message ?? error)
    });
  } finally {
    clearInterval(heartbeat);
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  port.onMessage.addListener((message) => {
    if (message?.type === 'run') void runCheck(port, message.payload);
  });
});

// Clicking the toolbar icon opens settings when no popup is configured.
chrome.runtime.onInstalled?.addListener(() => {});
