import test from 'node:test';
import assert from 'node:assert/strict';

import { claimCaption, videoCaption } from '../Src/ui/factCheck.js';
import { scoreVideo } from '../Src/core/scoring.js';

/**
 * The pill and the panel report the same check, and they must not contradict
 * each other.
 *
 * They disagreed in the shipped build: the pill read "9 claims" beside a panel
 * headed "12 claims". Both numbers were right — unverified claims are excluded
 * from accuracy, so a twelve-claim video with three unverified scores off nine
 * — but calling the smaller one "claims" made two correct numbers look like a
 * bug.
 */

test('names the judged subset instead of calling it the claim count', () => {
  assert.equal(claimCaption(9, 12), '9 of 12 judged');
});

test('says nothing extra when every claim was judged', () => {
  assert.equal(claimCaption(12, 12), '12 claims');
  assert.equal(claimCaption(1, 1), '1 claim');
});

test('falls back to a bare count when the total is unknown', () => {
  // Records written before claimCount existed still have to render.
  assert.equal(claimCaption(9, undefined), '9 claims');
  assert.equal(claimCaption(9, null), '9 claims');
});

test('marks thin evidence in words, not colour alone', () => {
  assert.equal(claimCaption(4, 12, 25), '4 of 12 judged · thin');
  assert.equal(claimCaption(4, 12, 75), '4 of 12 judged');
  assert.equal(videoCaption(3, 25), 'channel · 3 videos · thin');
});

test('the channel average counts videos, not claims', () => {
  assert.equal(videoCaption(3), 'channel · 3 videos');
  assert.equal(videoCaption(1), 'channel · 1 video');
});

test('the caption matches what the score was actually computed from', () => {
  // The reported case: twelve claims, three of which the research did not
  // settle. Drive it through the real scorer rather than asserting on numbers
  // typed by hand.
  const claims = [
    ...Array.from({ length: 7 }, () => ({ verdict: 'supported', centrality: 'core' })),
    { verdict: 'misleading', centrality: 'supporting' },
    { verdict: 'contradicted', centrality: 'core' },
    ...Array.from({ length: 3 }, () => ({ verdict: 'unverified', centrality: 'aside' }))
  ];

  const score = scoreVideo({ claims, framing: 62, sourcing: 55 });

  assert.equal(score.claimCount, 12, 'every claim extracted');
  assert.equal(score.judged, 9, 'unverified claims are excluded from accuracy');
  assert.equal(claimCaption(score.judged, score.claimCount, score.confidence), '9 of 12 judged');

  // The panel breakdown must sum to the claim count, or the two lines cannot
  // be reconciled by eye.
  const { supported = 0, misleading = 0, contradicted = 0, unverified = 0 } = score.counts;
  assert.equal(supported + misleading + contradicted + unverified, score.claimCount);
  assert.equal(supported + misleading + contradicted, score.judged);
});
