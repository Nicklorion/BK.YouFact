/**
 * Mounts controls and keeps them mounted.
 *
 * Two things make this harder than "querySelectorAll and append":
 *
 * YouTube recycles renderer elements. A card that showed channel A can be
 * reused for channel B without being recreated, so an existing button is only
 * valid if its `data-youfact-for` still matches — otherwise it is replaced.
 *
 * Our own insertions mutate the DOM the observer is watching. Mounting is
 * idempotent and debounced so that feedback loop settles instead of spinning.
 */

import { createBlockButton, MARKER } from './blockButton.js';
import { findAllMounts } from './anchors.js';

const RESCAN_DELAY_MS = 300;

function existingButton(container) {
  return container.querySelector(`:scope > [${MARKER}="block"], :scope > [${MARKER}="block-wrapper"]`);
}

/** Button width plus the gap we want between it and the native ⋮. */
const OVERLAY_SIZE = 32;
const OVERLAY_GAP = 2;

function insert(node, mount) {
  if (mount.position === 'prepend') mount.container.prepend(node);
  else if (mount.position === 'before' && mount.reference?.parentElement === mount.container) {
    mount.container.insertBefore(node, mount.reference);
  } else mount.container.append(node);
}

/**
 * Park an overlay button immediately left of the native ⋮.
 *
 * Offsets are read from the holder rather than hardcoded, and expressed as
 * `right` rather than `left` so they survive the container being resized —
 * the holder is right-anchored, so its distance from the right edge is stable
 * while its distance from the left edge is not.
 */
function alignOverlay(node, mount) {
  const holder = mount.alignTo;
  if (!holder?.isConnected) return;

  node.setAttribute('data-youfact-overlay', '');
  node.style.top = `${holder.offsetTop + (holder.offsetHeight - OVERLAY_SIZE) / 2}px`;
  node.style.right = `${mount.container.clientWidth - holder.offsetLeft + OVERLAY_GAP}px`;
}

export function createInjector({ onActivate, doc = document }) {
  let timer = null;
  let observer = null;

  function mountAll() {
    let mounted = 0;

    for (const mount of findAllMounts(doc)) {
      const existing = existingButton(mount.container);

      if (existing) {
        // Same channel: nothing to do. Different channel: the element was
        // recycled and the stale button must go.
        if (existing.getAttribute('data-youfact-for') === mount.channelId) continue;
        existing.remove();
      }

      const node = createBlockButton({
        variant: mount.variant,
        channelId: mount.channelId,
        channelName: mount.channelName,
        onActivate
      });

      insert(node, mount);
      if (mount.placement === 'overlay') alignOverlay(node, mount);
      mounted += 1;
    }

    return mounted;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      mountAll();
    }, RESCAN_DELAY_MS);
  }

  return {
    start() {
      mountAll();
      observer = new MutationObserver(schedule);
      observer.observe(doc.documentElement, { childList: true, subtree: true });
      window.addEventListener('yt-navigate-finish', schedule);
    },
    stop() {
      observer?.disconnect();
      observer = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    refresh: schedule,
    mountAll
  };
}
