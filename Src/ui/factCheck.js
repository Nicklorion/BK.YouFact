/**
 * The fact-check control: a split pill and its three levels of disclosure.
 *
 * Level 1 is the badge — a number is never shown without the sample size that
 * earned it, because a bare score with no `n` is the most dishonest thing this
 * UI could display. Level 2 lists every claim with its verdict. Level 3 opens
 * one claim to the quote, the reasoning and the sources.
 *
 * Colour is never the only signal: verdicts carry a word, scores carry a count,
 * and thin evidence is rendered muted rather than green.
 */

import { formatTimestamp } from '../youtube/transcript.js';

export const MARKER = 'data-youfact-ui';

const VERDICT_LABEL = {
  supported: 'supported',
  contradicted: 'contradicted',
  misleading: 'misleading',
  unverified: 'unverified'
};

const STAGE_LABEL = {
  extract: 'Reading transcript',
  research: 'Researching claims',
  judge: 'Weighing evidence'
};

const thin = (text, confidence) =>
  confidence != null && confidence < 50 ? `${text} · thin` : text;

/**
 * The sample size behind a video's score.
 *
 * `judged` and `claimCount` are different numbers and both are right: accuracy
 * is the weighted mean over claims the evidence actually settled, and
 * unverified ones are excluded rather than counted as false — see
 * `scoreAccuracy`. So a video with twelve claims and three unverified scores
 * off nine.
 *
 * Calling that "9 claims" beside a panel headed "12 claims" made two correct
 * numbers look like a bug. Name which is which, and say nothing extra when
 * they agree.
 *
 * The "thin" suffix is words rather than colour alone: a muted gauge tells a
 * colour-blind reader nothing, and a 78 off four judged claims should not read
 * like a 78 off forty.
 */
export function claimCaption(judged, claimCount, confidence) {
  const size =
    claimCount != null && claimCount !== judged
      ? `${judged} of ${claimCount} judged`
      : `${judged} ${judged === 1 ? 'claim' : 'claims'}`;
  return thin(size, confidence);
}

/** The channel average is over videos, not claims — a different unit entirely. */
export function videoCaption(videos, confidence) {
  return thin(`channel · ${videos} ${videos === 1 ? 'video' : 'videos'}`, confidence);
}

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};

function scoreTone(score, confidence) {
  if (score == null) return 'none';
  if (confidence != null && confidence < 50) return 'thin';
  if (score >= 70) return 'good';
  if (score >= 45) return 'mixed';
  return 'poor';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
};

/**
 * A 180° arc: centre (22,26), radius 19, swept left to right.
 *
 * Sized to fill the pill rather than to be polite about it. The point of the
 * redesign was legibility, and a smaller arc would seat a numeral smaller than
 * the plain number it replaced — at 30 units tall in a 36px pill the numeral
 * clears 18px, against 15px before.
 */
const ARC = 'M 3 26 A 19 19 0 0 1 41 26';
const ARC_LENGTH = Math.PI * 19;

/** Gradient ids must be unique per document, and the panel mounts a second gauge. */
let gaugeSequence = 0;

/**
 * The score as a filled arc.
 *
 * The gradient runs red → amber → green along the arc rather than recolouring
 * the whole sweep, so the colour under the tip is the colour of that score:
 * a 30 fills only the red end, a 90 runs all the way through to green. That
 * makes position and hue say the same thing instead of competing.
 *
 * The numeral stays inside the cup, and thin evidence drops the gradient for
 * flat grey — an arc that looks confident is a lie when four of twelve claims
 * were judged. Colour is never the only signal here either: the caption beside
 * the gauge carries the sample size, and says "thin" in words when it is.
 */
function createGauge(size = 44) {
  const id = `youfact-gauge-${(gaugeSequence += 1)}`;
  const svg = svgEl('svg', {
    class: 'youfact-gauge',
    viewBox: '0 0 44 30',
    width: size,
    height: Math.round((size * 30) / 44),
    // The number is read out by the button's own label; announcing the SVG
    // again would just repeat it.
    'aria-hidden': 'true',
    focusable: 'false'
  });

  const gradient = svgEl('linearGradient', { id, x1: '0', y1: '0', x2: '1', y2: '0' });
  gradient.append(
    svgEl('stop', { offset: '0', 'stop-color': '#d85a30' }),
    svgEl('stop', { offset: '0.5', 'stop-color': '#ba7517' }),
    svgEl('stop', { offset: '1', 'stop-color': '#1d9e75' })
  );
  const defs = svgEl('defs');
  defs.append(gradient);

  const track = svgEl('path', { class: 'youfact-gauge__track', d: ARC });
  const fill = svgEl('path', {
    class: 'youfact-gauge__fill',
    d: ARC,
    stroke: `url(#${id})`,
    'stroke-dasharray': ARC_LENGTH,
    'stroke-dashoffset': ARC_LENGTH
  });

  const value = svgEl('text', { class: 'youfact-gauge__value', x: '22', y: '26', 'text-anchor': 'middle' });
  value.textContent = '–';

  svg.append(defs, track, fill, value);

  return {
    node: svg,
    /** @param {number|null} score 0-100 @param {string} tone from `scoreTone` */
    set(score, tone) {
      svg.dataset.tone = tone;
      const known = typeof score === 'number' && Number.isFinite(score);
      const clamped = known ? Math.max(0, Math.min(100, score)) : 0;
      fill.setAttribute('stroke-dashoffset', ARC_LENGTH * (1 - clamped / 100));

      const text = known ? String(Math.round(clamped)) : '–';
      value.textContent = text;
      // Measured against the arc, in viewBox units: two digits at 16 clear the
      // stroke by 3.4, three digits at 16 clear it by 0.2 — a perfect score
      // would sit on the arc. Three digits get their own size rather than
      // every score paying for the one that can reach 100.
      value.style.fontSize = text.length >= 3 ? '13px' : '16px';
    }
  };
}

/**
 * @param {{onActivate: () => void, onOpen: () => void}} handlers
 */
export function createFactCheckPill({ onActivate, onOpen }) {
  const node = el('div', 'youfact-pill');
  node.setAttribute(MARKER, 'factcheck');

  const action = el('button', 'youfact-pill__action');
  action.type = 'button';
  const actionLabel = el('span', null, 'Fact-check');
  action.append(actionLabel);

  const badge = el('button', 'youfact-pill__badge');
  badge.type = 'button';
  const gauge = createGauge(44);
  // Sample size lives here because a score without one is the most dishonest
  // thing this UI could show, and the gauge has no room for it.
  const caption = el('span', 'youfact-pill__caption', 'not checked');
  badge.append(gauge.node, caption);

  node.append(action, badge);
  action.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onActivate();
  });
  badge.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpen();
  });

  return {
    node,
    /**
     * @param {{kind: string, channel?: object|null, video?: object|null,
     *          stage?: string, claimCount?: number, message?: string,
     *          detail?: string, elapsedMs?: number}} state
     */
    setState(state) {
      node.dataset.kind = state.kind;
      // A check takes tens of seconds and costs money. Leaving the action live
      // through all of it means every impatient second click silently abandons
      // the run in flight and pays for a new one.
      action.disabled = state.kind === 'running';

      if (state.kind === 'running') {
        // Research can sit inside one stage for minutes. A running clock is
        // the difference between "working" and "hung" for anyone watching.
        const parts = [STAGE_LABEL[state.stage] ?? 'Checking'];
        if (state.researched != null && state.claimCount) {
          // Research is per claim now, so it has a denominator worth showing.
          parts.push(`${state.researched}/${state.claimCount}`);
        } else if (state.claimCount) {
          parts.push(`${state.claimCount} claims`);
        }
        if (state.elapsedMs >= 5000) parts.push(`${Math.round(state.elapsedMs / 1000)}s`);

        actionLabel.textContent = parts.join(' · ');
        // The gauge deliberately keeps whatever it was showing: a re-check
        // should not blank the score you already have while it runs.
        badge.disabled = true;
        node.title = 'A check is already running — this button is disabled until it finishes.';
        return;
      }

      if (state.kind === 'error') {
        actionLabel.textContent = 'Retry';
        caption.textContent = state.message ?? 'failed';
        badge.disabled = true;
        node.dataset.tone = 'none';
        // The caption has room for three words; the provider's actual
        // complaint is what you need to fix it. Hover gets the whole thing.
        node.title = state.detail ?? state.message ?? 'The check failed.';
        return;
      }

      node.title = '';

      const video = state.video;
      const channel = state.channel;

      if (video?.score) {
        const { composite, judged, claimCount, confidence } = video.score;
        const tone = scoreTone(composite, confidence);

        // "Checked" restates what the gauge already shows. "Details" says what
        // the button does.
        actionLabel.textContent = 'Details';
        gauge.set(composite, tone);
        caption.textContent = claimCaption(judged, claimCount, confidence);
        node.dataset.tone = tone;
        badge.disabled = false;
        badge.setAttribute(
          'aria-label',
          `Credibility ${composite ?? 'unscored'} out of 100, from ${judged} of ` +
            `${claimCount ?? judged} claims judged. Opens the claim list.`
        );
        return;
      }

      actionLabel.textContent = 'Fact-check';

      if (channel?.composite != null) {
        const tone = scoreTone(channel.composite, channel.confidence);
        gauge.set(channel.composite, tone);
        caption.textContent = videoCaption(channel.videos, channel.confidence);
        node.dataset.tone = tone;
        badge.disabled = false;
        badge.setAttribute(
          'aria-label',
          `Channel credibility ${channel.composite} out of 100, averaged over ` +
            `${channel.videos} checked ${channel.videos === 1 ? 'video' : 'videos'}.`
        );
        return;
      }

      gauge.set(null, 'none');
      caption.textContent = 'not checked';
      badge.disabled = true;
      badge.removeAttribute('aria-label');
      node.dataset.tone = 'none';
    }
  };
}

function claimRow(claim) {
  const row = el('div', 'youfact-claim');

  const head = el('div', 'youfact-claim__head');
  const verdict = el('span', 'youfact-claim__verdict', VERDICT_LABEL[claim.verdict] ?? claim.verdict);
  verdict.dataset.verdict = claim.verdict;
  const time = el('span', 'youfact-claim__time', formatTimestamp(claim.timestampMs ?? 0));
  const text = el('span', 'youfact-claim__text', claim.claim);
  const chevron = el('span', 'youfact-claim__chevron', '▾');
  head.append(verdict, time, text, chevron);

  const body = el('div', 'youfact-claim__body');

  const quote = el('blockquote', 'youfact-claim__quote', `"${claim.quote}"`);
  const reasoning = el('p', 'youfact-claim__reasoning', claim.reasoning);
  body.append(quote, reasoning);

  const sourceList = (label, sources) => {
    if (!sources?.length) return;
    body.append(el('div', 'youfact-claim__label', label));
    for (const source of sources) {
      const link = el('a', 'youfact-claim__source', source.title || source.url);
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      body.append(link);
    }
  };

  sourceList('Sources the verdict rests on', claim.sources);
  sourceList('Also consulted, not decisive', claim.consulted);

  // An unverified claim is only honest if it says what was tried. Four
  // searches that turned up nothing is a finding about the claim; zero
  // searches is a finding about the checker, and the two must not look alike.
  if (!claim.sources?.length) {
    const errors = claim.searchErrors?.length ? ` — search error: ${claim.searchErrors.join(', ')}` : '';
    let note;
    if (claim.notResearched) {
      // A deliberate skip is not a failure, and must not read like one.
      note = 'Not researched — an aside; raise the research depth to include these';
    } else if (claim.searches == null) {
      note = 'No sources settled this claim';
    } else if (claim.searches > 0) {
      note = `No source settled this claim — ${claim.searches} ${claim.searches === 1 ? 'search' : 'searches'} run${errors}`;
    } else {
      note = `No sources settled this claim — no search ran${errors}`;
    }
    body.append(el('div', 'youfact-claim__label', note));
  }

  head.addEventListener('click', () => {
    const open = row.classList.toggle('is-open');
    chevron.textContent = open ? '▴' : '▾';
  });

  row.append(head, body);
  return row;
}

/** Level 2, with level 3 folded inside each row. */
export function createPanel({ record, channel, onRecheck, onClose }) {
  const panel = el('div', 'youfact-panel');
  panel.setAttribute(MARKER, 'panel');

  const header = el('div', 'youfact-panel__head');
  const score = record?.score;

  if (score) {
    // The same gauge as the pill, larger. Two different renderings of one
    // number is one more thing to learn to read.
    const gauge = createGauge(88);
    gauge.set(score.composite, scoreTone(score.composite, score.confidence));

    // "this video" was a label doing no work. The thing worth saying here is
    // what the number on the gauge was computed from — which is also what
    // reconciles it with the claim list below.
    const judged =
      score.claimCount != null && score.claimCount !== score.judged
        ? `${score.judged} of ${score.claimCount} claims judged`
        : `${score.claimCount ?? score.judged} claims judged`;

    const summary = el(
      'span',
      'youfact-panel__summary',
      channel?.composite != null
        ? `${judged} · channel average ${channel.composite} across ${channel.videos}`
        : judged
    );
    header.append(gauge.node, summary);
  } else {
    header.append(el('span', 'youfact-panel__summary', 'Not checked yet'));
  }

  const close = el('button', 'youfact-panel__close', '✕');
  close.type = 'button';
  close.addEventListener('click', onClose);
  header.append(close);
  panel.append(header);

  if (score) {
    // Every verdict, including supported, so the breakdown visibly sums to the
    // claim count in the line above. Omitting the one that usually dominates
    // left the reader unable to check the arithmetic against the list.
    const counts = score.counts ?? {};
    panel.append(
      el(
        'div',
        'youfact-panel__counts',
        `${counts.supported ?? 0} supported · ${counts.misleading ?? 0} misleading · ` +
          `${counts.contradicted ?? 0} contradicted · ${counts.unverified ?? 0} unverified`
      )
    );

    const axes = el('div', 'youfact-panel__axes');
    for (const [label, key] of [['Accuracy', 'accuracy'], ['Framing', 'framing'], ['Sourcing', 'sourcing']]) {
      const axis = el('div', 'youfact-axis');
      axis.append(el('span', 'youfact-axis__label', label));
      const track = el('span', 'youfact-axis__track');
      const fill = el('span', 'youfact-axis__fill');
      fill.style.width = `${score[key] ?? 0}%`;
      fill.dataset.tone = scoreTone(score[key], score.confidence);
      track.append(fill);
      axis.append(track, el('span', 'youfact-axis__value', score[key] == null ? '–' : String(score[key])));
      axes.append(axis);
    }
    panel.append(axes);

    const claims = el('div', 'youfact-panel__claims');
    for (const claim of record.claims ?? []) claims.append(claimRow(claim));
    panel.append(claims);

    const footer = el('div', 'youfact-panel__foot');
    footer.append(
      el(
        'span',
        null,
        `${record.model} · ${record.effort} effort · thinking ${record.thinking} · prompt v${record.promptVersion}`
      )
    );
    const recheck = el('button', 'youfact-panel__link', 'Re-check');
    recheck.type = 'button';
    recheck.addEventListener('click', onRecheck);
    footer.append(recheck);
    panel.append(footer);
  }

  return panel;
}
