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

export const STAGE = Object.freeze({
  EXTRACT: 'extract',
  RESEARCH: 'research',
  JUDGE: 'judge',
  DONE: 'done',
  FAILED: 'failed'
});

async function runCheck(port, { videoId, channelId, metadata, passages }) {
  const settings = await loadSettings();

  if (!isConfigured(settings)) {
    port.postMessage({ stage: STAGE.FAILED, reason: 'not-configured' });
    return;
  }
  if (!passages?.length) {
    port.postMessage({ stage: STAGE.FAILED, reason: 'no-transcript' });
    return;
  }

  const usage = [];

  try {
    port.postMessage({ stage: STAGE.EXTRACT });
    const extracted = await extractClaims(settings, {
      passages,
      metadata,
      maxClaims: settings.maxClaims
    });
    usage.push({ stage: STAGE.EXTRACT, ...extracted.usage });

    if (!extracted.claims.length) {
      port.postMessage({ stage: STAGE.FAILED, reason: 'no-claims' });
      return;
    }
    port.postMessage({ stage: STAGE.RESEARCH, claimCount: extracted.claims.length });

    const research = await researchClaims(settings, { claims: extracted.claims, metadata });
    usage.push({ stage: STAGE.RESEARCH, ...research.usage });

    port.postMessage({ stage: STAGE.JUDGE, sourceCount: research.sources.length });

    const judged = await judgeClaims(settings, {
      claims: extracted.claims,
      notes: research.notes
    });
    usage.push({ stage: STAGE.JUDGE, ...judged.usage });

    // Stitch verdicts back onto their claims. A claim the judge skipped stays
    // unverified rather than silently vanishing from the count.
    const byIndex = new Map(judged.verdicts.map((verdict) => [verdict.index, verdict]));
    const claims = extracted.claims.map((claim, index) => {
      const verdict = byIndex.get(index);
      return {
        ...claim,
        verdict: verdict?.verdict ?? 'unverified',
        confidence: verdict?.confidence ?? 'low',
        reasoning: verdict?.reasoning ?? 'The judging stage returned no verdict for this claim.',
        sources: (verdict?.sourceUrls ?? [])
          .map((url) => research.sources.find((source) => source.url === url) ?? { url, title: url })
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

    port.postMessage({ stage: STAGE.DONE, record });
  } catch (error) {
    port.postMessage({ stage: STAGE.FAILED, reason: 'provider-error', message: String(error.message ?? error) });
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
