/**
 * Measures how the research stage is actually billed.
 *
 * Docs/cost.md asserts two things it cannot prove from one observation:
 *
 *   1. Input tokens grow quadratically with the search budget, because the
 *      server-side loop re-bills accumulated results on every iteration.
 *   2. Prompt caching might collapse that, if cache_control survives the loop.
 *
 * Both are testable. This spends real money to find out — roughly the cost of
 * one Standard check — so it prints its plan and exits unless you pass --run.
 *
 *   ANTHROPIC_API_KEY=sk-ant-... node Tools/costProbe.mjs --run
 *
 * The key is read from the environment and never printed. Output is token
 * counts only.
 */

import { RESEARCH_SYSTEM } from '../Src/model/anthropic.js';
import { RATES, COST_PER_SEARCH, formatCost } from '../Src/core/cost.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = process.env.PROBE_MODEL ?? 'claude-sonnet-5';
const BUDGETS = [1, 2, 3, 4];

/** One claim, reused everywhere, so every row differs only in the variable. */
const CLAIM =
  'A single modern EUV lithography scanner costs around $150-200 million or more.';

const key = process.env.ANTHROPIC_API_KEY;
const rate = RATES[MODEL] ?? RATES['claude-sonnet-5'];

const emptyUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  web_search_requests: 0,
  round_trips: 0
});

const addUsage = (total, usage) => ({
  input_tokens: total.input_tokens + (usage?.input_tokens ?? 0),
  output_tokens: total.output_tokens + (usage?.output_tokens ?? 0),
  cache_creation_input_tokens:
    total.cache_creation_input_tokens + (usage?.cache_creation_input_tokens ?? 0),
  cache_read_input_tokens: total.cache_read_input_tokens + (usage?.cache_read_input_tokens ?? 0),
  web_search_requests:
    total.web_search_requests + (usage?.server_tool_use?.web_search_requests ?? 0),
  round_trips: total.round_trips + 1
});

const costOf = (u) =>
  (u.input_tokens / 1e6) * rate.input +
  (u.cache_creation_input_tokens / 1e6) * rate.input * 1.25 +
  (u.cache_read_input_tokens / 1e6) * rate.input * 0.1 +
  (u.output_tokens / 1e6) * rate.output +
  u.web_search_requests * COST_PER_SEARCH;

/** One research turn, resumed through any pause_turn, usage summed. */
async function research({ maxUses, cached }) {
  const system = cached
    ? [{ type: 'text', text: RESEARCH_SYSTEM, cache_control: { type: 'ephemeral' } }]
    : RESEARCH_SYSTEM;

  const messages = [
    {
      role: 'user',
      content: `Claim to research:\n"${CLAIM}"\n\nSearch for evidence bearing on this claim and report what you find.`
    }
  ];

  let usage = emptyUsage();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 8000,
        system,
        messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: maxUses }],
        output_config: { effort: 'medium' }
      })
    });

    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(`${response.status} ${detail?.error?.message ?? response.statusText}`);
    }

    const message = await response.json();
    usage = addUsage(usage, message.usage);

    if (message.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: message.content });
  }

  return usage;
}

const row = (label, u) =>
  [
    label.padEnd(22),
    String(u.web_search_requests).padStart(8),
    u.input_tokens.toLocaleString('en-US').padStart(12),
    u.cache_read_input_tokens.toLocaleString('en-US').padStart(11),
    u.cache_creation_input_tokens.toLocaleString('en-US').padStart(11),
    u.output_tokens.toLocaleString('en-US').padStart(8),
    String(u.round_trips).padStart(6),
    formatCost(costOf(u)).padStart(8)
  ].join(' ');

const header = () =>
  console.log(
    '\n' +
      [
        'probe'.padEnd(22),
        'searches'.padStart(8),
        'input'.padStart(12),
        'cache rd'.padStart(11),
        'cache wr'.padStart(11),
        'output'.padStart(8),
        'trips'.padStart(6),
        'cost'.padStart(8)
      ].join(' ') +
      '\n' +
      '-'.repeat(92)
  );

async function main() {
  if (!key) {
    console.error(
      'ANTHROPIC_API_KEY is not set.\n' +
        'Set it in your shell for this command only; the script never prints it.'
    );
    process.exit(1);
  }

  if (!process.argv.includes('--run')) {
    console.log(
      `\nWould run ${BUDGETS.length + 2} requests against ${MODEL}:\n` +
        `  - ${BUDGETS.length} scaling probes at max_uses ${BUDGETS.join(', ')}\n` +
        '  - 2 identical cached probes at max_uses 3, to see if a warm cache reads\n\n' +
        `Roughly ${formatCost(1.0)} of real spend, mostly search-result tokens.\n` +
        'Re-run with --run to execute.\n'
    );
    return;
  }

  console.log(`\nModel ${MODEL} · $${rate.input}/MTok in, $${rate.output}/MTok out`);

  // 1. Scaling. If input grows as s(s+1)/2 the quadratic claim holds; if it
  //    grows as s, results are billed once and Docs/cost.md overstates depth.
  header();
  const scaling = [];
  for (const maxUses of BUDGETS) {
    const usage = await research({ maxUses, cached: false });
    scaling.push({ maxUses, usage });
    console.log(row(`scaling max_uses=${maxUses}`, usage));
  }

  // 2. Caching. Two identical requests; the second should read what the first
  //    wrote, if the prefix clears the model's minimum at all.
  const cold = await research({ maxUses: 3, cached: true });
  console.log(row('cached (cold)', cold));
  const warm = await research({ maxUses: 3, cached: true });
  console.log(row('cached (warm)', warm));

  // --- verdict -----------------------------------------------------------
  const base = scaling.find((s) => s.usage.web_search_requests === 1) ?? scaling[0];
  const baseSearches = base.usage.web_search_requests || 1;
  const baseInput = base.usage.input_tokens;

  console.log('\nScaling, against the search count actually run:\n');
  console.log('  searches   observed x   if linear   if quadratic');
  for (const { usage } of scaling) {
    const s = usage.web_search_requests;
    if (!s || s === baseSearches) continue;
    const observed = usage.input_tokens / baseInput;
    const linear = s / baseSearches;
    const quadratic = (s * (s + 1)) / (baseSearches * (baseSearches + 1));
    console.log(
      `  ${String(s).padStart(8)}   ${observed.toFixed(2).padStart(10)}   ` +
        `${linear.toFixed(2).padStart(9)}   ${quadratic.toFixed(2).padStart(12)}`
    );
  }

  const top = scaling.at(-1).usage;
  if (top.web_search_requests > baseSearches) {
    const s = top.web_search_requests;
    const observed = top.input_tokens / baseInput;
    const linear = s / baseSearches;
    const quadratic = (s * (s + 1)) / (baseSearches * (baseSearches + 1));
    const verdict =
      Math.abs(observed - quadratic) < Math.abs(observed - linear)
        ? 'QUADRATIC — Docs/cost.md is right, and depth is the dominant lever.'
        : 'LINEAR — results are not re-billed per iteration. Docs/cost.md overstates depth; recalibrate.';
    console.log(`\n  Verdict: ${verdict}`);
  }

  const cachedAnything = warm.cache_read_input_tokens > 0;
  console.log(
    `\nCaching: warm run read ${warm.cache_read_input_tokens.toLocaleString('en-US')} cached tokens ` +
      `(cold wrote ${cold.cache_creation_input_tokens.toLocaleString('en-US')}).`
  );
  console.log(
    cachedAnything
      ? '  Caching engages. Compare the warm cost above against the uncached max_uses=3 row\n' +
          '  to see how much of the search context it actually covers.'
      : '  Nothing cached. The research prefix is almost certainly below the model minimum\n' +
          '  (512 tokens on Sonnet 5), so caching cannot help this stage as it is shaped.'
  );

  const total = [...scaling.map((s) => s.usage), cold, warm].reduce(
    (sum, u) => sum + costOf(u),
    0
  );
  console.log(`\nProbe spend: ${formatCost(total)}\n`);
}

main().catch((error) => {
  console.error(`\nProbe failed: ${error.message}\n`);
  process.exit(1);
});
