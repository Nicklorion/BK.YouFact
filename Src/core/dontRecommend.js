/**
 * "Don't recommend channel", with an undo window we build ourselves.
 *
 * YouTube's feedback response carries no undo token — verified against a live
 * 200 response. Its own Undo only exists in the transient snackbar after a UI
 * click, and even that does not fully reverse the algorithmic effect. So once
 * the request is sent there is no clean way back.
 *
 * That makes optimistic-and-deferred the honest design:
 *
 *   1. Block locally straight away, so the channel disappears immediately.
 *   2. Hold the request for `undoWindowMs` and offer Undo.
 *   3. Only then spend the token.
 *
 * The user gets an instant, reversible-feeling action, and we never send an
 * irreversible request that someone did not mean.
 */

import { sendFeedback } from '../youtube/innertube.js';

export const OUTCOME = Object.freeze({
  UNDONE: 'undone',
  SENT: 'sent',
  FAILED: 'failed',
  LOCAL_ONLY: 'local-only'
});

export function createDontRecommend({
  cache,
  blocklist,
  getClientConfig,
  send = sendFeedback,
  undoWindowMs = 5000,
  now = () => Date.now()
}) {
  /** @type {Map<string, {timer: unknown, resolve: (value: object) => void, settled: Promise<object>}>} */
  const pending = new Map();

  async function fire(channelId) {
    const entry = pending.get(channelId);
    if (!entry) return null;
    pending.delete(channelId);
    clearTimeout(entry.timer);

    const cached = cache.get(channelId);
    const clientConfig = getClientConfig();

    // No token, or not signed in: the channel stays hidden locally. That is a
    // complete outcome, not a failure — it just doesn't reach the algorithm.
    if (!cached || !clientConfig) {
      const result = { channelId, outcome: OUTCOME.LOCAL_ONLY, reason: cached ? 'no-client-config' : 'no-token' };
      entry.resolve(result);
      return result;
    }

    try {
      const response = await send({ clientConfig, feedbackTokens: [cached.token] });
      cache.recordOutcome({ ageMs: cached.ageMs, ok: response.ok });

      if (response.ok) {
        await blocklist.markSent(channelId);
        // Spent tokens are single-use as far as we know; drop it so a later
        // attempt re-harvests rather than replaying a stale one.
        cache.forget(channelId);
        const result = { channelId, outcome: OUTCOME.SENT, tokenAgeMs: cached.ageMs, status: response.status };
        entry.resolve(result);
        return result;
      }

      const result = {
        channelId,
        outcome: OUTCOME.FAILED,
        tokenAgeMs: cached.ageMs,
        status: response.status,
        processed: response.processed
      };
      entry.resolve(result);
      return result;
    } catch (error) {
      cache.recordOutcome({ ageMs: cached.ageMs, ok: false });
      const result = { channelId, outcome: OUTCOME.FAILED, tokenAgeMs: cached.ageMs, error: String(error) };
      entry.resolve(result);
      return result;
    }
  }

  const api = {
    /**
     * Hide the channel now, send the feedback after the undo window closes.
     *
     * @returns {{undo: () => Promise<boolean>, settled: Promise<object>, firesAt: number}}
     */
    request(channelId, { token = null, name = null } = {}) {
      if (token) cache.remember(channelId, token);

      const existing = pending.get(channelId);
      if (existing) {
        return { undo: () => api.undo(channelId), settled: existing.settled, firesAt: existing.firesAt };
      }

      void blocklist.block(channelId, { name });

      let resolve;
      const settled = new Promise((r) => {
        resolve = r;
      });
      const timer = setTimeout(() => void fire(channelId), undoWindowMs);
      const firesAt = now() + undoWindowMs;

      pending.set(channelId, { timer, resolve, settled, firesAt });

      return { undo: () => api.undo(channelId), settled, firesAt };
    },

    /**
     * Cancel before the request goes out. Returns false once it has been sent —
     * at that point there is genuinely nothing to undo.
     */
    async undo(channelId) {
      const entry = pending.get(channelId);
      if (!entry) return false;

      pending.delete(channelId);
      clearTimeout(entry.timer);
      await blocklist.unblock(channelId);
      entry.resolve({ channelId, outcome: OUTCOME.UNDONE });
      return true;
    },

    /** Send everything still waiting. For pagehide, so nothing is silently dropped. */
    async flush() {
      const channelIds = [...pending.keys()];
      return Promise.all(channelIds.map((channelId) => fire(channelId)));
    },

    isPending(channelId) {
      return pending.has(channelId);
    },

    pendingCount() {
      return pending.size;
    }
  };

  return api;
}
