/**
 * Persisted check results.
 *
 * Keyed by video, aggregated to channel on read. Stores the evidence, not just
 * the number: a score nobody can interrogate is worth nothing, and the panel's
 * deepest level renders straight out of here.
 */

import { read, write } from './storage.js';
import { scoreChannel } from './scoring.js';

const KEY = 'checks';
const MAX_VIDEOS = 400;

export function createCheckStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, object>} */
  const byVideo = new Map();
  let loaded = false;

  async function load() {
    if (loaded) return;
    loaded = true;
    const stored = await read(KEY, {});
    for (const [videoId, record] of Object.entries(stored ?? {})) {
      if (!byVideo.has(videoId)) byVideo.set(videoId, record);
    }
  }

  async function persist() {
    if (byVideo.size > MAX_VIDEOS) {
      const oldest = [...byVideo.entries()]
        .sort((a, b) => a[1].checkedAt - b[1].checkedAt)
        .slice(0, byVideo.size - MAX_VIDEOS);
      for (const [videoId] of oldest) byVideo.delete(videoId);
    }
    await write(KEY, Object.fromEntries(byVideo));
  }

  return {
    load,

    async save(record) {
      byVideo.set(record.videoId, { ...record, checkedAt: record.checkedAt ?? now() });
      await persist();
    },

    getVideo(videoId) {
      return byVideo.get(videoId) ?? null;
    },

    /** Aggregate across everything checked for this channel. */
    getChannel(channelId) {
      const videos = [...byVideo.values()].filter((record) => record.channelId === channelId);
      if (!videos.length) return null;
      return scoreChannel(
        videos.map((record) => ({ ...record.score, checkedAt: record.checkedAt })),
        now()
      );
    },

    async forget(videoId) {
      if (byVideo.delete(videoId)) await persist();
    },

    size() {
      return byVideo.size;
    }
  };
}
