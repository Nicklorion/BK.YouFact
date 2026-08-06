import test from 'node:test';
import assert from 'node:assert/strict';

import { scoreAccuracy, scoreConfidence, composite, scoreVideo, scoreChannel } from '../Src/core/scoring.js';

const claim = (verdict, centrality = 'supporting') => ({ verdict, centrality });

test('accuracy weights claims by how load-bearing they are', () => {
  // One false core claim outweighs one true aside.
  const lopsided = scoreAccuracy([claim('contradicted', 'core'), claim('supported', 'aside')]);
  assert.equal(lopsided.accuracy, 25);
  assert.equal(lopsided.judged, 2);

  const reversed = scoreAccuracy([claim('supported', 'core'), claim('contradicted', 'aside')]);
  assert.equal(reversed.accuracy, 75);
});

test('unverified claims are excluded from accuracy, not counted against it', () => {
  // Otherwise videos about obscure subjects get punished for being obscure.
  const withUnverified = scoreAccuracy([claim('supported'), claim('unverified'), claim('unverified')]);
  assert.equal(withUnverified.accuracy, 100);
  assert.equal(withUnverified.judged, 1, 'unverified must not inflate the sample size either');
});

test('accuracy is null when nothing was actually judged', () => {
  const nothing = scoreAccuracy([claim('unverified'), claim('unverified')]);
  assert.equal(nothing.accuracy, null);
  assert.equal(scoreConfidence(nothing.judged), 0);
});

test('misleading sits between supported and contradicted', () => {
  const value = scoreAccuracy([claim('misleading')]).accuracy;
  assert.ok(value > 0 && value < 100, `expected a middling score, got ${value}`);
});

test('confidence tracks evidence volume, not model certainty', () => {
  assert.equal(scoreConfidence(0), 0);
  assert.ok(scoreConfidence(2) < scoreConfidence(5));
  assert.ok(scoreConfidence(5) < scoreConfidence(20));
});

test('composite ignores axes that were never measured', () => {
  assert.equal(composite({ accuracy: 80, framing: null, sourcing: null }), 80);
  assert.equal(composite({ accuracy: null, framing: null, sourcing: null }), null);
  // Accuracy dominates when everything is present.
  assert.ok(composite({ accuracy: 100, framing: 0, sourcing: 0 }) > 50);
});

test('scoreVideo reports the verdict breakdown alongside the number', () => {
  const score = scoreVideo({
    claims: [claim('supported'), claim('contradicted'), claim('unverified')],
    framing: 60,
    sourcing: 40
  });
  assert.equal(score.claimCount, 3);
  assert.equal(score.judged, 2);
  assert.deepEqual(score.counts, { supported: 1, contradicted: 1, unverified: 1 });
  assert.equal(typeof score.composite, 'number');
});

test('channel scoring decays old videos toward irrelevance', () => {
  const now = Date.UTC(2026, 0, 1);
  const year = 365 * 86_400_000;

  const recentGood = scoreChannel(
    [
      { composite: 90, judged: 10, claimCount: 10, checkedAt: now },
      { composite: 10, judged: 10, claimCount: 10, checkedAt: now - year }
    ],
    now
  );
  const oldGood = scoreChannel(
    [
      { composite: 10, judged: 10, claimCount: 10, checkedAt: now },
      { composite: 90, judged: 10, claimCount: 10, checkedAt: now - year }
    ],
    now
  );

  assert.ok(recentGood.composite > oldGood.composite, 'recent behaviour must dominate');
  assert.equal(recentGood.videos, 2);
});

test('channel scoring returns null rather than inventing a number', () => {
  assert.equal(scoreChannel([]), null);
  assert.equal(scoreChannel([{ composite: null, judged: 0 }]), null);
});
