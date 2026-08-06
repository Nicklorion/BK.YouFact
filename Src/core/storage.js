/**
 * Thin promise wrapper over chrome.storage.local, with an in-memory fallback so
 * modules stay unit-testable outside an extension host.
 */

const memory = new Map();

const area = globalThis.chrome?.storage?.local ?? null;

export async function read(key, fallback = null) {
  if (!area) return memory.has(key) ? memory.get(key) : fallback;
  const bag = await area.get(key);
  return key in bag ? bag[key] : fallback;
}

export async function write(key, value) {
  if (!area) {
    memory.set(key, value);
    return;
  }
  await area.set({ [key]: value });
}

/**
 * Coalesce bursts of writes to one persist per `delayMs`. The harvester fires on
 * every feed render with ~20 items; without this each render would be a
 * storage round-trip per item.
 */
export function debouncePersist(key, delayMs = 500) {
  let timer = null;
  let latest;

  return {
    schedule(value) {
      latest = value;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void write(key, latest);
      }, delayMs);
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (latest !== undefined) await write(key, latest);
    }
  };
}
