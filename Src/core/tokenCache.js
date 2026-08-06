/**
 * Per-channel cache of "Don't recommend channel" feedback tokens.
 *
 * Why this exists: tokens are minted per impression, not per channel. Four
 * videos from one channel in a single sidebar yielded four distinct tokens, and
 * the tokens are server-encrypted so nothing can be derived or constructed.
 * Meanwhile the surfaces that *offer* the action (home feed, watch sidebar) are
 * not the surface where the user wants the button (under the video). So we
 * harvest opportunistically wherever tokens appear and spend them elsewhere.
 *
 * A token harvested from the home feed fired successfully 50s later from an
 * unrelated watch page. Longer-lived reuse is unproven, which is what
 * `recordOutcome` is for: every fire logs the token's age and whether it
 * worked, so the real expiry curve falls out of usage instead of guesswork.
 */

import { read, debouncePersist } from './storage.js';

const CACHE_KEY = 'tokenCache';
const OUTCOME_KEY = 'tokenOutcomes';

/** Roughly a browsing session's worth of channels; entries are ~250 bytes. */
const MAX_ENTRIES = 500;

/** Enough samples to see a curve without unbounded growth. */
const MAX_OUTCOMES = 200;

export function createTokenCache({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {token: string, at: number}>} */
  const entries = new Map();
  /** @type {Array<{ageMs: number, ok: boolean, at: number}>} */
  let outcomes = [];

  const cachePersist = debouncePersist(CACHE_KEY);
  const outcomePersist = debouncePersist(OUTCOME_KEY);
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    const stored = await read(CACHE_KEY, {});

    // Harvesting starts before storage resolves, so a stored entry must never
    // displace one already in memory unless it is genuinely newer.
    for (const [channelId, entry] of Object.entries(stored ?? {})) {
      if (!entry?.token) continue;
      const live = entries.get(channelId);
      if (!live || entry.at > live.at) entries.set(channelId, entry);
    }

    const storedOutcomes = (await read(OUTCOME_KEY, [])) ?? [];
    outcomes = [...storedOutcomes, ...outcomes].slice(-MAX_OUTCOMES);
  }

  function evictOldest() {
    if (entries.size <= MAX_ENTRIES) return;
    const sorted = [...entries.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [channelId] of sorted.slice(0, entries.size - MAX_ENTRIES)) {
      entries.delete(channelId);
    }
  }

  function persist() {
    cachePersist.schedule(Object.fromEntries(entries));
  }

  return {
    load,

    /**
     * Record a token seen for a channel. Newer always wins — a fresher token is
     * strictly more likely to still be valid when spent.
     */
    remember(channelId, token) {
      if (!channelId || !token) return;
      entries.set(channelId, { token, at: now() });
      evictOldest();
      persist();
    },

    /** Bulk form for a whole feed render. */
    rememberAll(items) {
      let added = 0;
      for (const item of items ?? []) {
        if (!item?.channelId || !item?.token) continue;
        entries.set(item.channelId, { token: item.token, at: now() });
        added += 1;
      }
      if (added) {
        evictOldest();
        persist();
      }
      return added;
    },

    /** @returns {{token: string, ageMs: number}|null} */
    get(channelId) {
      const entry = entries.get(channelId);
      if (!entry) return null;
      return { token: entry.token, ageMs: now() - entry.at };
    },

    has(channelId) {
      return entries.has(channelId);
    },

    forget(channelId) {
      if (entries.delete(channelId)) persist();
    },

    /** Feeds the expiry curve. Call after every fire, success or failure. */
    recordOutcome({ ageMs, ok }) {
      outcomes.push({ ageMs, ok, at: now() });
      if (outcomes.length > MAX_OUTCOMES) outcomes = outcomes.slice(-MAX_OUTCOMES);
      outcomePersist.schedule(outcomes);
    },

    /**
     * Observed success rate bucketed by token age. Once a bucket goes cold this
     * is what tells us to stop trusting old tokens and fall back to the
     * blocklist instead of firing a doomed request.
     */
    expiryStats() {
      const buckets = [
        { label: '<1m', max: 60_000 },
        { label: '<1h', max: 3_600_000 },
        { label: '<1d', max: 86_400_000 },
        { label: '>=1d', max: Infinity }
      ].map((bucket) => ({ ...bucket, ok: 0, total: 0 }));

      for (const outcome of outcomes) {
        const bucket = buckets.find((candidate) => outcome.ageMs < candidate.max);
        if (!bucket) continue;
        bucket.total += 1;
        if (outcome.ok) bucket.ok += 1;
      }

      return buckets.map(({ label, ok, total }) => ({
        label,
        ok,
        total,
        rate: total ? ok / total : null
      }));
    },

    size() {
      return entries.size;
    },

    async flush() {
      await Promise.all([cachePersist.flush(), outcomePersist.flush()]);
    }
  };
}
