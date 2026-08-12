/**
 * User configuration.
 *
 * Stored in chrome.storage.local rather than .sync deliberately: an API key is
 * bearer credential and syncing it would push it through Google's servers to
 * every signed-in browser. Local storage keeps it on this machine — still
 * readable by anything with access to the profile, which the options page says
 * out loud rather than implying it is safe.
 */

import { read, write } from './storage.js';

const KEY = 'settings';

export const PROVIDERS = Object.freeze({
  anthropic: {
    label: 'Anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    keyPrefix: 'sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-5', label: 'Opus 5 — most capable' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5 — fastest, cheapest' }
    ],
    supportsThinking: true
  }
});

/**
 * How hard to look before calling a claim unverified.
 *
 * Kept separate from `effort`, which buys reasoning depth. They are different
 * questions: a claim can need one lookup and careful judgement, or ten lookups
 * and none. This is the budget of web searches spent on each individual claim,
 * so total searches is roughly this times the claim count — it is the second
 * cost lever after `maxClaims`, and the one that decides whether a verdict can
 * cite anything at all.
 */
export const RESEARCH_DEPTHS = Object.freeze({
  quick: { label: 'Quick — 2 searches per claim', searchesPerClaim: 2 },
  standard: { label: 'Standard — 4 searches per claim', searchesPerClaim: 4 },
  deep: { label: 'Deep — 8 searches per claim', searchesPerClaim: 8 },
  exhaustive: { label: 'Exhaustive — 15 searches per claim', searchesPerClaim: 15 }
});

export const DEFAULTS = Object.freeze({
  provider: 'anthropic',
  apiKey: '',
  model: 'claude-opus-5',
  /** Maps to reasoning budget and to how hard the research stage digs. */
  effort: 'medium',
  /** off | auto | on — auto asks for thinking only on the research stage. */
  thinking: 'auto',
  /** Ceiling on claims extracted per video; the main cost lever. */
  maxClaims: 12,
  /** How many web searches each claim gets before it is called unverified. */
  researchDepth: 'standard',
  /** Skip videos shorter than this — Shorts rarely carry checkable claims. */
  minDurationSeconds: 60,
  /** Never call the model without the user asking. */
  autoCheck: false
});

export const EFFORTS = Object.freeze(['low', 'medium', 'high']);
export const THINKING_MODES = Object.freeze(['off', 'auto', 'on']);

export function validate(settings) {
  const problems = [];
  const provider = PROVIDERS[settings.provider];

  if (!provider) problems.push({ field: 'provider', message: 'Unknown provider' });
  if (!settings.apiKey) {
    problems.push({ field: 'apiKey', message: 'An API key is required to run checks' });
  } else if (provider?.keyPrefix && !settings.apiKey.startsWith(provider.keyPrefix)) {
    problems.push({
      field: 'apiKey',
      message: `${provider.label} keys start with ${provider.keyPrefix}`
    });
  }
  if (provider && !provider.models.some((model) => model.id === settings.model)) {
    problems.push({ field: 'model', message: 'Pick a model available for this provider' });
  }
  if (!EFFORTS.includes(settings.effort)) problems.push({ field: 'effort', message: 'Invalid effort' });
  if (!THINKING_MODES.includes(settings.thinking)) {
    problems.push({ field: 'thinking', message: 'Invalid thinking mode' });
  }
  if (!RESEARCH_DEPTHS[settings.researchDepth]) {
    problems.push({ field: 'researchDepth', message: 'Invalid research depth' });
  }
  if (!Number.isInteger(settings.maxClaims) || settings.maxClaims < 1 || settings.maxClaims > 50) {
    problems.push({ field: 'maxClaims', message: 'Claims per video must be between 1 and 50' });
  }

  return problems;
}

export async function loadSettings() {
  const stored = await read(KEY, {});
  return { ...DEFAULTS, ...(stored ?? {}) };
}

export async function saveSettings(settings) {
  const merged = { ...DEFAULTS, ...settings };
  const problems = validate(merged);
  if (problems.length) return { ok: false, problems };
  await write(KEY, merged);
  return { ok: true, settings: merged };
}

/** True when a check could actually run. The UI uses this to stay honest. */
export function isConfigured(settings) {
  return validate(settings).length === 0;
}
