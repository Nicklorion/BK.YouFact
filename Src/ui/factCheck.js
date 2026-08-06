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
  const badgeValue = el('span', 'youfact-pill__value', '–');
  const badgeMeta = el('span', 'youfact-pill__meta');
  badge.append(badgeValue, badgeMeta);

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
     *          stage?: string, claimCount?: number, message?: string}} state
     */
    setState(state) {
      node.dataset.kind = state.kind;
      badge.disabled = state.kind === 'idle' || state.kind === 'running';

      if (state.kind === 'running') {
        actionLabel.textContent = state.claimCount
          ? `${STAGE_LABEL[state.stage] ?? 'Checking'} · ${state.claimCount} claims`
          : (STAGE_LABEL[state.stage] ?? 'Checking');
        node.dataset.tone = 'none';
        return;
      }

      if (state.kind === 'error') {
        actionLabel.textContent = 'Retry';
        badgeValue.textContent = '!';
        badgeMeta.textContent = state.message ?? 'failed';
        node.dataset.tone = 'none';
        return;
      }

      const video = state.video;
      const channel = state.channel;

      if (video?.score) {
        actionLabel.textContent = 'Checked';
        badgeValue.textContent = video.score.composite ?? '–';
        badgeMeta.textContent = `vid · ${video.score.judged}`;
        node.dataset.tone = scoreTone(video.score.composite, video.score.confidence);
        return;
      }

      actionLabel.textContent = 'Fact-check';
      if (channel?.composite != null) {
        badgeValue.textContent = channel.composite;
        badgeMeta.textContent = `ch · ${channel.videos}`;
        node.dataset.tone = scoreTone(channel.composite, channel.confidence);
      } else {
        badgeValue.textContent = '–';
        badgeMeta.textContent = '';
        node.dataset.tone = 'none';
      }
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

  if (claim.sources?.length) {
    body.append(el('div', 'youfact-claim__label', 'Sources retrieved at check time'));
    for (const source of claim.sources) {
      const link = el('a', 'youfact-claim__source', source.title || source.url);
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noreferrer';
      body.append(link);
    }
  } else {
    body.append(el('div', 'youfact-claim__label', 'No sources settled this claim'));
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
    const value = el('span', 'youfact-panel__score', String(score.composite ?? '–'));
    value.dataset.tone = scoreTone(score.composite, score.confidence);
    const summary = el(
      'span',
      'youfact-panel__summary',
      channel?.composite != null
        ? `this video · channel average ${channel.composite} across ${channel.videos}`
        : 'this video'
    );
    header.append(value, summary);
  } else {
    header.append(el('span', 'youfact-panel__summary', 'Not checked yet'));
  }

  const close = el('button', 'youfact-panel__close', '✕');
  close.type = 'button';
  close.addEventListener('click', onClose);
  header.append(close);
  panel.append(header);

  if (score) {
    const counts = score.counts ?? {};
    panel.append(
      el(
        'div',
        'youfact-panel__counts',
        `${score.claimCount} claims · ${counts.contradicted ?? 0} contradicted · ` +
          `${counts.misleading ?? 0} misleading · ${counts.unverified ?? 0} unverified`
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
