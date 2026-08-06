/**
 * Undo toast.
 *
 * This is the visible half of the deferred-fire design. YouTube returns no undo
 * token, so the window between the click and the request is the only undo that
 * will ever exist — the countdown is not decoration, it is the user's actual
 * chance to take it back.
 */

const CLASS = 'youfact-toast';

let current = null;

function clear() {
  if (!current) return;
  clearInterval(current.ticker);
  current.node.remove();
  current = null;
}

/**
 * @param {{message: string, windowMs: number, onUndo: () => void, onExpire?: () => void}} options
 */
export function showUndoToast({ message, windowMs, onUndo, onExpire }) {
  clear();

  const node = document.createElement('div');
  node.className = CLASS;

  const text = document.createElement('div');
  text.className = 'youfact-toast__text';
  text.textContent = message;

  const sub = document.createElement('span');
  sub.className = 'youfact-toast__sub';
  text.append(sub);

  const undo = document.createElement('button');
  undo.className = 'youfact-toast__undo';
  undo.type = 'button';
  undo.textContent = 'Undo';

  node.append(text, undo);
  document.body.append(node);

  const endsAt = Date.now() + windowMs;

  const render = () => {
    const remaining = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
    sub.textContent = remaining
      ? `Telling YouTube in ${remaining}s — this cannot be undone afterwards`
      : 'Sent to YouTube';
    if (remaining === 0) {
      clearInterval(current.ticker);
      undo.remove();
      onExpire?.();
      setTimeout(clear, 2500);
    }
  };

  undo.addEventListener('click', () => {
    onUndo();
    clear();
  });

  current = { node, ticker: setInterval(render, 250) };
  render();

  return { dismiss: clear };
}
