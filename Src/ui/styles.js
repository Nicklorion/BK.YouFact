/**
 * Injected styles.
 *
 * Deliberately does not reuse YouTube's own class names or `--yt-spec-*`
 * variables. Those are internal and get renamed; `html[dark]` has been the
 * theme signal for years and is what we key off instead. Measured values are
 * matched by hand so injected controls sit correctly beside native ones:
 *
 *   watch action bar  40px tall, 20px radius, 14px text
 *   Shorts rail       48px circle, 24px radius
 */

const CSS = `
.youfact-btn {
  --youfact-surface: rgba(0, 0, 0, 0.05);
  --youfact-surface-hover: rgba(0, 0, 0, 0.1);
  --youfact-ink: #0f0f0f;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  cursor: pointer;
  font-family: inherit;
  background: var(--youfact-surface);
  color: var(--youfact-ink);
  white-space: nowrap;
  transition: background 120ms ease, opacity 120ms ease;
}
html[dark] .youfact-btn {
  --youfact-surface: rgba(255, 255, 255, 0.1);
  --youfact-surface-hover: rgba(255, 255, 255, 0.2);
  --youfact-ink: #f1f1f1;
}
.youfact-btn:hover { background: var(--youfact-surface-hover); }
.youfact-btn:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 2px; }
.youfact-btn svg { width: 24px; height: 24px; fill: currentColor; flex: none; }

.youfact-btn--watch {
  height: 40px;
  border-radius: 20px;
  padding: 0 16px;
  font-size: 14px;
  font-weight: 500;
  margin-left: 8px;
}

.youfact-btn--item {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  padding: 0;
  background: transparent;
  opacity: 0;
  flex: none;
}
/*
 * Lockup cards lay their metadata row out as flex with the native ⋮ holder
 * absolutely positioned on top. A static child there gets squeezed and buried
 * under the menu, so overlay mounts are absolute too and are offset from the
 * holder at mount time.
 */
.youfact-btn--item[data-youfact-overlay] { position: absolute; }
.youfact-btn--item svg { width: 20px; height: 20px; }
[data-youfact-channel]:hover .youfact-btn--item,
.youfact-btn--item:focus-visible { opacity: 1; }
.youfact-btn--item:hover { background: var(--youfact-surface-hover); }

.youfact-short {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-bottom: 16px;
}
.youfact-btn--short {
  width: 48px;
  height: 48px;
  border-radius: 24px;
  padding: 0;
}
.youfact-short__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--youfact-ink, #f1f1f1);
  text-align: center;
  line-height: 1.2;
}

.youfact-toast {
  position: fixed;
  left: 24px;
  bottom: 24px;
  z-index: 9000;
  display: flex;
  align-items: center;
  gap: 16px;
  max-width: 420px;
  padding: 14px 16px;
  border-radius: 12px;
  background: #212121;
  color: #f1f1f1;
  font-family: "Roboto", "Arial", sans-serif;
  font-size: 14px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
}
html:not([dark]) .youfact-toast { background: #0f0f0f; }
.youfact-toast__text { flex: 1; }
.youfact-toast__sub { display: block; margin-top: 2px; font-size: 12px; color: #aaa; }
.youfact-toast__undo {
  border: none;
  background: none;
  color: #3ea6ff;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 4px;
}
.youfact-toast__undo:hover { background: rgba(62, 166, 255, 0.1); }
`;

const STYLE_ID = 'youfact-styles';

export function installStyles(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).append(style);
}
