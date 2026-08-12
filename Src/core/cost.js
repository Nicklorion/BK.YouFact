/**
 * What a check will cost, before you pay for it.
 *
 * Pure arithmetic over published rates. `Docs/cost.md` records where the model
 * comes from and how far it can be trusted — read it before treating any
 * number here as more than an order of magnitude.
 *
 * The estimate exists because the honest version of this number is not
 * guessable from the settings. The old options hint stated a search count and
 * let the reader infer the cost from the $0.01 fee, which understated the real
 * figure by more than ten times: the fees are not the expense, the tokens the
 * searches drag into context are.
 */

/** US dollars per million tokens. Confirmed against the pricing docs 2026-08-12. */
export const RATES = Object.freeze({
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-haiku-4-5-20251001': { input: 1, output: 5 }
});

/** $10 per 1,000 searches, charged on top of the tokens they produce. */
export const COST_PER_SEARCH = 0.01;

const DEFAULT_RATE = RATES['claude-sonnet-5'];

/**
 * Tokens one search adds to the context, after dynamic filtering.
 *
 * The largest source of error in everything below. Calibrated against a single
 * observed check — 12 claims, 4 searches each, $3.88 — so treat it as an order
 * of magnitude that happens to fit one data point, not a measurement.
 */
const TOKENS_PER_SEARCH = 12000;

/** Notes plus thinking written while researching one claim. */
const OUTPUT_TOKENS_PER_CLAIM = 2500;

/** Transcript in and claims out, then the dossiers in and verdicts out. */
const FIXED_INPUT_TOKENS = 23000;
const FIXED_OUTPUT_TOKENS = 6000;

/**
 * Input tokens billed for researching one claim.
 *
 * Each iteration of the server-side search loop is billed the whole
 * conversation so far, so the results of search 1 are paid for again on every
 * search after it. The total is quadratic in the budget:
 *
 *   2 searches ->  3 units      6 searches -> 21 units
 *   3 searches ->  6 units     10 searches -> 55 units
 */
export function researchInputTokens(searches) {
  if (!Number.isFinite(searches) || searches <= 0) return 0;
  return TOKENS_PER_SEARCH * ((searches * (searches + 1)) / 2);
}

/**
 * A ceiling, not a forecast. It assumes every claim is researched and every
 * search in the budget is spent; both are caps the model often comes in under,
 * and asides are skipped below Deep. Overshooting is the right direction for a
 * number whose job is to stop a surprise.
 *
 * @param {{claims: number, searchesPerClaim: number, model?: string,
 *          researchedClaims?: number}} plan
 */
export function estimateCheckCost({ claims, searchesPerClaim, model, researchedClaims }) {
  const researched = researchedClaims ?? claims;
  if (!Number.isFinite(researched) || researched <= 0) return 0;

  const rate = RATES[model] ?? DEFAULT_RATE;
  const input = FIXED_INPUT_TOKENS + researched * researchInputTokens(searchesPerClaim);
  const output = FIXED_OUTPUT_TOKENS + researched * OUTPUT_TOKENS_PER_CLAIM;
  const searches = researched * searchesPerClaim;

  return (input / 1e6) * rate.input + (output / 1e6) * rate.output + searches * COST_PER_SEARCH;
}

/** Cents while cents still mean something, whole dollars once they do not. */
export function formatCost(dollars) {
  if (!Number.isFinite(dollars) || dollars < 0) return '–';
  return dollars >= 10 ? `$${Math.round(dollars)}` : `$${dollars.toFixed(2)}`;
}
