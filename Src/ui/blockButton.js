/**
 * The "Don't recommend channel" control, in the three shapes the surfaces need.
 *
 * On the watch page this button is doing something YouTube itself does not
 * offer — there is no native don't-recommend under a video. Everywhere else it
 * collapses an interaction that natively costs two clicks and a menu into one.
 */

const ICON =
  'M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8' +
  's3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zM7 11h10v2H7z';

export const MARKER = 'data-youfact-ui';

function icon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON);
  svg.append(path);
  return svg;
}

/**
 * @param {{variant: 'watch'|'item'|'short', channelId: string, channelName?: string|null,
 *          label?: string, onActivate: (channelId: string, channelName: string|null) => void}} options
 * @returns {HTMLElement} the node to insert — for Shorts this is a labelled wrapper
 */
export function createBlockButton({
  variant,
  channelId,
  channelName = null,
  label = "Don't recommend",
  onActivate
}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `youfact-btn youfact-btn--${variant}`;
  button.setAttribute(MARKER, 'block');
  button.setAttribute('data-youfact-for', channelId);
  button.setAttribute('aria-label', `${label} — ${channelName ?? 'this channel'}`);
  button.title = button.getAttribute('aria-label');
  button.append(icon());

  if (variant === 'watch') {
    button.append(document.createTextNode(label));
  }

  button.addEventListener('click', (event) => {
    // Item and Shorts anchors sit inside links and clickable cards.
    event.preventDefault();
    event.stopPropagation();
    onActivate(channelId, channelName);
  });

  if (variant !== 'short') return button;

  const wrapper = document.createElement('div');
  wrapper.className = 'youfact-short';
  wrapper.setAttribute(MARKER, 'block-wrapper');
  wrapper.setAttribute('data-youfact-for', channelId);

  const caption = document.createElement('div');
  caption.className = 'youfact-short__label';
  caption.textContent = label;

  wrapper.append(button, caption);
  return wrapper;
}
