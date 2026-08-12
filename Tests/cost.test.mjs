import test from 'node:test';
import assert from 'node:assert/strict';

import { estimateCheckCost, researchInputTokens, formatCost, RATES } from '../Src/core/cost.js';
import { RESEARCH_DEPTHS } from '../Src/core/settings.js';

/**
 * The estimate exists to stop a surprise, so what matters is that it is the
 * right shape and errs high — not that it is precise. The one number it is
 * calibrated against is an observed $3.88 check: 12 claims, 4 searches each,
 * Sonnet 5.
 */

test('search cost is quadratic, which is the whole point', () => {
  // Each search is re-billed on every search after it, so the budget compounds.
  // A linear model is what made the old hint understate the bill by 10x.
  assert.equal(researchInputTokens(2) / researchInputTokens(1), 3);
  assert.equal(researchInputTokens(3) / researchInputTokens(1), 6);
  assert.equal(researchInputTokens(6) / researchInputTokens(1), 21);
  assert.equal(researchInputTokens(10) / researchInputTokens(1), 55);
});

test('a zero or nonsense budget costs nothing rather than NaN', () => {
  assert.equal(researchInputTokens(0), 0);
  assert.equal(researchInputTokens(-3), 0);
  assert.equal(researchInputTokens(undefined), 0);
});

test('reproduces the observed check within a fifth', () => {
  // The old defaults: 12 claims at 4 searches each on Sonnet 5, billed $3.88.
  const estimate = estimateCheckCost({
    claims: 12,
    searchesPerClaim: 4,
    model: 'claude-sonnet-5'
  });

  assert.ok(
    Math.abs(estimate - 3.88) / 3.88 < 0.2,
    `expected within 20% of the observed $3.88, got ${estimate.toFixed(2)}`
  );
});

test('the new defaults are materially cheaper than the old ones', () => {
  const model = 'claude-sonnet-5';
  const before = estimateCheckCost({ claims: 12, searchesPerClaim: 4, model });
  const after = estimateCheckCost({
    claims: 12,
    searchesPerClaim: RESEARCH_DEPTHS.standard.searchesPerClaim,
    model
  });

  assert.ok(after < before * 0.7, `expected a real cut, ${after.toFixed(2)} vs ${before.toFixed(2)}`);
});

test('skipping asides comes off the top of the dominant stage', () => {
  const plan = { claims: 12, searchesPerClaim: 3, model: 'claude-sonnet-5' };
  const all = estimateCheckCost(plan);
  const withoutAsides = estimateCheckCost({ ...plan, researchedClaims: 8 });

  assert.ok(withoutAsides < all * 0.8, 'four fewer researched claims should show clearly');
});

test('prices per model rather than assuming one', () => {
  const plan = { claims: 12, searchesPerClaim: 3 };
  const sonnet = estimateCheckCost({ ...plan, model: 'claude-sonnet-5' });
  const opus = estimateCheckCost({ ...plan, model: 'claude-opus-5' });

  assert.ok(opus > sonnet * 2, 'Opus is 2.5x the token rate and must show it');
  assert.equal(RATES['claude-opus-5'].input / RATES['claude-sonnet-5'].input, 2.5);
});

test('an unknown model falls back rather than returning NaN', () => {
  const estimate = estimateCheckCost({ claims: 12, searchesPerClaim: 3, model: 'claude-opus-9' });
  assert.ok(Number.isFinite(estimate) && estimate > 0);
});

test('formats cents while cents mean something', () => {
  assert.equal(formatCost(1.7043), '$1.70');
  assert.equal(formatCost(9.99), '$9.99');
  assert.equal(formatCost(17.4), '$17');
  assert.equal(formatCost(NaN), '–');
});

test('every depth is priced, and the ladder only goes up', () => {
  const plan = { claims: 12, model: 'claude-sonnet-5' };
  const ladder = Object.values(RESEARCH_DEPTHS).map((depth) =>
    estimateCheckCost({ ...plan, searchesPerClaim: depth.searchesPerClaim })
  );

  for (const cost of ladder) assert.ok(cost > 0 && Number.isFinite(cost));
  assert.deepEqual(ladder, [...ladder].sort((a, b) => a - b), 'depths must be ordered by cost');

  // The setting that prompted this: Exhaustive has to read as expensive,
  // because it is. The old hint implied $1.80 for it.
  assert.ok(ladder.at(-1) > 10, `Exhaustive should be visibly costly, got ${ladder.at(-1)}`);
});
