/**
 * Local channel blocklist.
 *
 * This is the layer that cannot break. Telling YouTube to stop recommending a
 * channel depends on tokens, schemas and an undocumented endpoint; hiding a
 * channel ourselves needs only its id, which is the most stable thing on the
 * page. It is also the only option on surfaces where YouTube offers no native
 * action at all — under a watch-page video, in search results, on channel pages.
 *
 * So the blocklist is not a fallback bolted on for failures. It is the source of
 * truth for what the user asked to be rid of; the InnerTube call is the extra
 * step that also nudges the algorithm.
 */

import { read, write } from './storage.js';

const KEY = 'blocklist';

export function createBlocklist({ now = () => Date.now() } = {}) {
  /** @type {Map<string, {at: number, name: string|null, sentToYouTube: boolean}>} */
  const entries = new Map();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    const stored = await read(KEY, {});
    // A block issued while storage was still resolving outranks the stored copy.
    for (const [channelId, entry] of Object.entries(stored ?? {})) {
      if (!entries.has(channelId)) entries.set(channelId, entry);
    }
  }

  async function persist() {
    await write(KEY, Object.fromEntries(entries));
  }

  return {
    load,

    async block(channelId, { name = null } = {}) {
      if (!channelId) return;
      entries.set(channelId, { at: now(), name, sentToYouTube: false });
      await persist();
    },

    async unblock(channelId) {
      if (entries.delete(channelId)) await persist();
    },

    /** Records that YouTube accepted the feedback, for display and diagnostics. */
    async markSent(channelId) {
      const entry = entries.get(channelId);
      if (!entry) return;
      entry.sentToYouTube = true;
      await persist();
    },

    has(channelId) {
      return entries.has(channelId);
    },

    get(channelId) {
      return entries.get(channelId) ?? null;
    },

    all() {
      return [...entries.entries()].map(([channelId, entry]) => ({ channelId, ...entry }));
    },

    size() {
      return entries.size;
    }
  };
}
