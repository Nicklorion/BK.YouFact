/**
 * Where each surface's button goes.
 *
 * Anchors are measured, not guessed — see Docs/dont-recommend.md. They are also
 * the most perishable thing in the extension, so every lookup degrades to null
 * rather than throwing: a missing anchor costs one button, not the extension.
 */

/** Channel source and insertion point differ on the watch page. */
export function findWatchMount(doc = document) {
  const owner = doc.querySelector('ytd-video-owner-renderer[data-youfact-channel]');
  if (!owner) return null;

  const metadata = doc.querySelector('ytd-watch-metadata');
  const container =
    metadata?.querySelector('#top-level-buttons-computed') ??
    metadata?.querySelector('ytd-menu-renderer');
  if (!container) return null;

  return {
    key: 'watch',
    container,
    position: 'append',
    channelId: owner.getAttribute('data-youfact-channel'),
    channelName: owner.getAttribute('data-youfact-channel-name')
  };
}

/**
 * Feed, grid and sidebar items. Renderers nest — a rich item wraps a lockup —
 * so only the innermost stamped element gets a button, otherwise cards would
 * sprout two.
 */
export function findItemMounts(doc = document) {
  const stamped = [...doc.querySelectorAll('[data-youfact-hideable][data-youfact-channel]')];

  const innermost = stamped.filter(
    (element) => !stamped.some((other) => other !== element && element.contains(other))
  );

  const mounts = [];
  for (const element of innermost) {
    const channelId = element.getAttribute('data-youfact-channel');
    if (!channelId) continue;

    // Sit next to the native ⋮ so the control reads as part of the card.
    const metadata = element.querySelector('yt-lockup-metadata-view-model');
    const menu = element.querySelector('ytd-menu-renderer');
    const channelName = element.getAttribute('data-youfact-channel-name');

    if (metadata) {
      // Found structurally rather than by class name: the absolutely
      // positioned child that holds a button is the ⋮ holder.
      const holder = [...metadata.children].find(
        (child) => getComputedStyle(child).position === 'absolute' && child.querySelector('button')
      );
      if (!holder) continue;

      mounts.push({
        key: `item:${channelId}`,
        container: metadata,
        position: 'append',
        placement: 'overlay',
        alignTo: holder,
        channelId,
        channelName
      });
    } else if (menu?.parentElement) {
      mounts.push({
        key: `item:${channelId}`,
        container: menu.parentElement,
        position: 'before',
        placement: 'inline',
        reference: menu,
        channelId,
        channelName
      });
    } else {
      const fallback = deriveOverlayFrom(element);
      if (fallback) mounts.push({ key: `item:${channelId}`, ...fallback, channelId, channelName });
    }
  }
  return mounts;
}

/**
 * Last-resort anchor for card shapes we have not measured — Shorts shelves on
 * the home feed being the case that prompted it.
 *
 * Derived entirely from layout: find the card's own ⋮, take the positioned box
 * it sits in, and mount into that box's positioning context. No tag names, no
 * class names, so it adapts to card types that did not exist when this was
 * written.
 */
function deriveOverlayFrom(element) {
  const native = [...element.querySelectorAll('button')].find(
    (button) => !button.hasAttribute('data-youfact-ui') && button.getBoundingClientRect().width > 0
  );
  if (!native) return null;

  const holder = native.offsetParent;
  const container = holder?.offsetParent;
  if (!holder || !container || !element.contains(container)) return null;

  return { container, position: 'append', placement: 'overlay', alignTo: holder };
}

/** The Shorts action rail — our control goes above Like, per the design. */
export function findShortMounts(doc = document) {
  const mounts = [];
  for (const reel of doc.querySelectorAll('ytd-reel-video-renderer[data-youfact-channel]')) {
    const rail = reel.querySelector('reel-action-bar-view-model');
    if (!rail) continue;

    const channelId = reel.getAttribute('data-youfact-channel');
    if (!channelId) continue;

    mounts.push({
      key: `short:${channelId}`,
      container: rail,
      position: 'prepend',
      channelId,
      channelName: reel.getAttribute('data-youfact-channel-name')
    });
  }
  return mounts;
}

export function findAllMounts(doc = document) {
  const watch = findWatchMount(doc);
  return [
    ...(watch ? [{ ...watch, variant: 'watch' }] : []),
    ...findItemMounts(doc).map((mount) => ({ ...mount, variant: 'item' })),
    ...findShortMounts(doc).map((mount) => ({ ...mount, variant: 'short' }))
  ];
}
