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

/* Tones never carry meaning alone — every score is shown with its sample size. */
.youfact-pill {
  display: inline-flex; height: 36px; border-radius: 18px; overflow: hidden;
  background: rgba(0, 0, 0, 0.05); margin-left: 8px; vertical-align: middle;
}
html[dark] .youfact-pill { background: rgba(255, 255, 255, 0.1); }
/* The pill's own tone custom properties went with the plain number they
   coloured. The data-tone attribute is still stamped on the element as a
   styling and debugging hook; the colour now lives in the gauge's gradient.
   Note this whole block is a JS template literal — no backticks in here. */
.youfact-pill button {
  border: none; background: none; font: inherit; font-size: 14px; cursor: pointer;
  color: #0f0f0f; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px;
}
html[dark] .youfact-pill button { color: #f1f1f1; }
.youfact-pill button:hover { background: rgba(0, 0, 0, 0.06); }
html[dark] .youfact-pill button:hover { background: rgba(255, 255, 255, 0.08); }
.youfact-pill button:disabled { cursor: default; }
/* Without this a disabled button still lights up under the cursor, which reads
   as "clickable, but nothing happened". */
.youfact-pill button:disabled:hover { background: none; }
html[dark] .youfact-pill button:disabled:hover { background: none; }
.youfact-pill__badge {
  border-left: 1px solid rgba(128, 128, 128, 0.35) !important;
  padding: 0 12px !important; gap: 8px !important;
}
.youfact-pill__caption { font-size: 11px; color: #8f8f8f; white-space: nowrap; }

/* The score as a filled arc. Stroke widths and the type size are in viewBox
   units, so the whole thing scales from the width attribute alone — 36 in the
   pill, 72 in the panel — with no second set of rules. */
.youfact-gauge { display: block; flex: none; overflow: visible; }
.youfact-gauge__track {
  fill: none; stroke: rgba(128, 128, 128, 0.3); stroke-width: 4; stroke-linecap: round;
}
.youfact-gauge__fill {
  fill: none; stroke-width: 4; stroke-linecap: round;
  transition: stroke-dashoffset .45s ease-out;
}
/* Size is set inline per value — a three-digit score needs a smaller face to
   clear the arc than a two-digit one. See createGauge. */
.youfact-gauge__value { font-weight: 500; fill: currentColor; }
/* Thin evidence drops the gradient: a confident-looking arc is a lie when four
   of twelve claims were judged. The caption says "thin" in words alongside. */
.youfact-gauge[data-tone="thin"] .youfact-gauge__fill { stroke: #909090; }
.youfact-gauge[data-tone="none"] .youfact-gauge__value { fill: #8f8f8f; }
@media (prefers-reduced-motion: reduce) { .youfact-gauge__fill { transition: none; } }
/* A check runs for tens of seconds with long silent stretches inside a single
   stage. A static label there is indistinguishable from a hung extension, so
   the running state breathes. */
.youfact-pill[data-kind="running"] .youfact-pill__action {
  opacity: .75; animation: youfact-working 1.6s ease-in-out infinite;
}
@keyframes youfact-working { 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) {
  .youfact-pill[data-kind="running"] .youfact-pill__action { animation: none; }
}

.youfact-panel {
  margin: 12px 0; padding: 14px; border-radius: 12px; max-width: 640px;
  border: 1px solid rgba(128,128,128,.3); background: rgba(0,0,0,.03); color: inherit;
  font-size: 13px; line-height: 1.55;
}
html[dark] .youfact-panel { background: rgba(255,255,255,.04); }
/* Centred, not baseline: the head now leads with a gauge, and an SVG has no
   baseline worth aligning text to. */
.youfact-panel__head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.youfact-panel__summary { color: #8f8f8f; flex: 1; }
.youfact-panel__close { border: none; background: none; color: #8f8f8f; cursor: pointer; font-size: 14px; }
.youfact-panel__counts { color: #8f8f8f; font-size: 12px; margin-bottom: 14px; }
.youfact-panel__axes { display: flex; flex-direction: column; gap: 7px; margin-bottom: 14px; }
.youfact-axis { display: flex; align-items: center; gap: 10px; }
.youfact-axis__label { font-size: 12px; color: #8f8f8f; width: 74px; }
.youfact-axis__track { flex: 1; height: 5px; border-radius: 3px; background: rgba(128,128,128,.25); }
.youfact-axis__fill { display: block; height: 100%; border-radius: 3px; background: var(--tone, #909090); }
.youfact-axis__fill[data-tone="good"] { --tone:#1d9e75; }
.youfact-axis__fill[data-tone="mixed"] { --tone:#ba7517; }
.youfact-axis__fill[data-tone="poor"] { --tone:#d85a30; }
.youfact-axis__value { font-size: 12px; width: 22px; text-align: right; }

.youfact-claim { border-top: 1px solid rgba(128,128,128,.22); }
.youfact-claim__head { display: flex; align-items: center; gap: 10px; padding: 8px 0; cursor: pointer; }
.youfact-claim__verdict {
  font-size: 10px; padding: 2px 7px; border-radius: 4px; width: 74px; text-align: center; flex: none;
  background: rgba(128,128,128,.22); color: inherit;
}
.youfact-claim__verdict[data-verdict="supported"]    { background: rgba(29,158,117,.22); color: #1d9e75; }
.youfact-claim__verdict[data-verdict="contradicted"] { background: rgba(216,90,48,.22); color: #d85a30; }
.youfact-claim__verdict[data-verdict="misleading"]   { background: rgba(186,117,23,.22); color: #ba7517; }
.youfact-claim__time { font-size: 12px; color: #8f8f8f; font-variant-numeric: tabular-nums; flex: none; }
.youfact-claim__text { flex: 1; }
.youfact-claim__chevron { color: #8f8f8f; flex: none; }
.youfact-claim__body { display: none; padding: 4px 0 12px 84px; }
.youfact-claim.is-open .youfact-claim__body { display: block; }
.youfact-claim__quote {
  margin: 0 0 8px; padding-left: 10px; border-left: 2px solid rgba(128,128,128,.35);
  color: #8f8f8f; font-style: normal;
}
.youfact-claim__reasoning { margin: 0 0 10px; }
.youfact-claim__label { font-size: 11px; color: #8f8f8f; margin-bottom: 4px; }
.youfact-claim__source { display: block; color: #3ea6ff; text-decoration: none; margin-bottom: 3px; }
.youfact-claim__source:hover { text-decoration: underline; }

.youfact-panel__foot {
  display: flex; justify-content: space-between; align-items: center; gap: 12px;
  border-top: 1px solid rgba(128,128,128,.22); margin-top: 10px; padding-top: 10px;
  font-size: 11px; color: #8f8f8f;
}
.youfact-panel__link { border: none; background: none; color: #3ea6ff; font: inherit; cursor: pointer; }
`;

const STYLE_ID = 'youfact-styles';

export function installStyles(doc = document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).append(style);
}
