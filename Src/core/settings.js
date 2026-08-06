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

export const DEFAULTS = Object.freeze({
  provider: 'anthropic',
  apiKey: '',
  model: 'claude-opus-5',
  /** Maps to reasoning budget and to how hard the research stage digs. */
  effort: 'medium',
  /** off | auto | on — auto enables thinking only for the judging stage. */
  thinking: 'auto',
  /** Ceiling on claims extracted per video; the main cost lever. */
  maxClaims: 12,
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
