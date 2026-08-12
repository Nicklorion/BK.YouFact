import test from 'node:test';
import assert from 'node:assert/strict';

import { extractClaims, researchClaims, judgeClaims } from '../Src/model/anthropic.js';

/**
 * These assert the request shape, not the model's answer.
 *
 * The shape is worth pinning because getting it wrong is a 400 rather than a
 * degraded result: `budget_tokens` was removed on the current models, `effort`
 * is not accepted by Haiku, and Fable rejects an explicit thinking disable.
 * Every one of those is silent until a real check runs and fails.
 */

/** Captures the outgoing body and replies with whatever the stage needs. */
function captureFetch(reply) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, json: async () => reply };
  };
  return calls;
}

const settings = (overrides = {}) => ({
  apiKey: 'sk-ant-test',
  model: 'claude-opus-5',
  effort: 'medium',
  thinking: 'auto',
  maxClaims: 12,
  researchDepth: 'standard',
  ...overrides
});

const CLAIMS_REPLY = {
  content: [{ type: 'tool_use', name: 'record_claims', input: { claims: [] } }],
  usage: { input_tokens: 1, output_tokens: 1 }
};

const RESEARCH_REPLY = {
  content: [{ type: 'text', text: 'Findings.', citations: [{ url: 'https://example.org', title: 'Ex' }] }],
  usage: { input_tokens: 1, output_tokens: 1 }
};

const passages = [{ startMs: 0, timestamp: '0:00', text: 'A claim.' }];
const claims = [{ claim: 'A claim.' }];

test('never sends budget_tokens to a model that rejects it', async () => {
  // The whole research stage 400d on claude-opus-5 because of this field, so
  // no check could ever complete on the default settings.
  for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5']) {
    const calls = captureFetch(RESEARCH_REPLY);
    await researchClaims(settings({ model }), { claims, metadata: null });

    const { body } = calls[0];
    assert.equal(body.thinking?.budget_tokens, undefined, `${model} must not receive budget_tokens`);
    assert.equal(body.thinking?.type, 'adaptive', `${model} should think adaptively`);
    assert.equal(body.output_config?.effort, 'medium');
  }
});

test('keeps the legacy budget for the one model that still takes it', async () => {
  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ model: 'claude-haiku-4-5-20251001' }), { claims, metadata: null });

  const { body } = calls[0];
  assert.equal(body.thinking.type, 'enabled');
  assert.equal(body.thinking.budget_tokens, 4000);
  assert.equal(body.output_config, undefined, 'Haiku does not accept effort');
  // The budget has to fit inside the ceiling with room for an answer.
  assert.ok(body.max_tokens > body.thinking.budget_tokens);
});

test('omits the thinking field entirely on the model that cannot disable it', async () => {
  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ model: 'claude-fable-5', thinking: 'off' }), {
    claims,
    metadata: null
  });

  assert.equal(calls[0].body.thinking, undefined, 'an explicit disable is a 400 here');
});

test('honours thinking off on models that allow it', async () => {
  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ thinking: 'off' }), { claims, metadata: null });

  assert.deepEqual(calls[0].body.thinking, { type: 'disabled' });
});

test('leaves the tool-forced stages at the model default under auto', async () => {
  // Disabling thinking on a forced tool choice is what makes a model write the
  // call into visible text instead of emitting it, which reads downstream as
  // "no checkable claims found".
  const calls = captureFetch(CLAIMS_REPLY);
  await extractClaims(settings(), { passages, metadata: null, maxClaims: 12 });

  assert.equal(calls[0].body.thinking, undefined);
  assert.deepEqual(calls[0].body.tool_choice, { type: 'tool', name: 'record_claims' });
});

test('picks the web search variant the model supports', async () => {
  const modern = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings(), { claims, metadata: null });
  assert.equal(modern[0].body.tools[0].type, 'web_search_20260209');

  const legacy = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ model: 'claude-haiku-4-5-20251001' }), { claims, metadata: null });
  assert.equal(legacy[0].body.tools[0].type, 'web_search_20250305');
});

test('treats a refusal as a failed request, not as an empty result', async () => {
  captureFetch({
    stop_reason: 'refusal',
    stop_details: { category: 'cyber' },
    content: [],
    usage: {}
  });

  await assert.rejects(
    () => extractClaims(settings(), { passages, metadata: null, maxClaims: 12 }),
    /declined this request \(cyber\)/
  );
});

test('assumes the current request shape for a model it has never seen', async () => {
  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ model: 'claude-opus-6' }), { claims, metadata: null });

  assert.equal(calls[0].body.thinking.type, 'adaptive');
  assert.equal(calls[0].body.output_config.effort, 'medium');
});

test('keeps the sources the research stage actually cited', async () => {
  captureFetch(RESEARCH_REPLY);
  const result = await researchClaims(settings(), { claims, metadata: null });

  assert.equal(result.findings[0].notes, 'Findings.');
  assert.deepEqual(result.sources, [{ url: 'https://example.org', title: 'Ex' }]);
});

test('judging returns empty rather than throwing when the tool is skipped', async () => {
  captureFetch({ content: [{ type: 'text', text: 'no tool call' }], usage: {} });
  const result = await judgeClaims(settings(), {
    claims,
    findings: [{ index: 0, claim: 'A claim.', notes: 'n', sources: [], searches: 1, searchErrors: [] }]
  });

  assert.deepEqual(result.verdicts, []);
  assert.equal(result.framing, null);
});

test('resumes a paused turn instead of returning half a search', async () => {
  // Server-side search runs its own sampling loop. When it hits the iteration
  // limit the turn comes back paused: the searches ran, but the model has not
  // written its findings. Treating that as finished is what produced twelve
  // claims of "unverified, no sources".
  let call = 0;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'pause_turn',
          content: [{ type: 'server_tool_use', name: 'web_search', input: { query: 'q' } }],
          usage: { input_tokens: 10, output_tokens: 5 }
        })
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'Found it.', citations: [{ url: 'https://a.test', title: 'A' }] }],
        usage: { input_tokens: 20, output_tokens: 7 }
      })
    };
  };

  const result = await researchClaims(settings(), { claims, metadata: null });

  assert.equal(call, 2, 'the paused turn must be resumed');
  const resumed = bodies[1].messages;
  assert.equal(resumed.at(-1).role, 'assistant', 'resume by echoing the assistant turn back');
  assert.equal(result.findings[0].notes, 'Found it.', 'the resumed half carries the findings');
  assert.equal(result.findings[0].searches, 1, 'the paused half carries the searches');
  assert.equal(result.usage.output_tokens, 12, 'usage covers every round trip');
});

test('harvests sources the model did not annotate', async () => {
  // Citations only cover what the model chose to lean on. A turn whose prose
  // comes back unannotated still consulted real pages, and dropping them reads
  // downstream as "no sources settled this claim".
  captureFetch({
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', name: 'web_search', input: { query: 'q' } },
      {
        type: 'web_search_tool_result',
        content: [
          { type: 'web_search_result', url: 'https://one.test', title: 'One' },
          { type: 'web_search_result', url: 'https://two.test', title: 'Two' }
        ]
      },
      { type: 'text', text: 'Summary with no citations.' }
    ],
    usage: {}
  });

  const result = await researchClaims(settings(), { claims, metadata: null });
  assert.deepEqual(
    result.findings[0].sources.map((s) => s.url),
    ['https://one.test', 'https://two.test']
  );
});

test('records a search error rather than crashing on it', async () => {
  // On failure the result block carries an error object where the list of
  // results would be. Indexing it blind throws.
  captureFetch({
    stop_reason: 'end_turn',
    content: [
      { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
      { type: 'text', text: 'Could not search further.' }
    ],
    usage: {}
  });

  const result = await researchClaims(settings(), { claims, metadata: null });
  assert.deepEqual(result.findings[0].searchErrors, ['max_uses_exceeded']);
  assert.deepEqual(result.findings[0].sources, []);
});

test('researches every claim, not whichever ones fit a shared budget', async () => {
  // The reported failure was twelve claims sharing one call with six searches:
  // most claims could not have been looked up even in principle.
  const calls = captureFetch(RESEARCH_REPLY);
  const twelve = Array.from({ length: 12 }, (_, i) => ({ claim: `Claim ${i}.`, quote: `q${i}` }));

  const result = await researchClaims(settings(), { claims: twelve, metadata: null });

  assert.equal(calls.length, 12, 'one request per claim');
  assert.equal(result.findings.length, 12);
  for (const [index, finding] of result.findings.entries()) {
    assert.equal(finding.index, index, 'findings must stay aligned with claim order');
    assert.match(calls[index].body.messages[0].content, new RegExp(`Claim ${index}\\.`));
  }
});

test('gives each claim its own search budget, set by research depth', async () => {
  for (const [depth, expected] of [
    ['quick', 2],
    ['standard', 3],
    ['deep', 6],
    ['exhaustive', 10]
  ]) {
    const calls = captureFetch(RESEARCH_REPLY);
    await researchClaims(settings({ researchDepth: depth }), { claims, metadata: null });
    assert.equal(calls[0].body.tools[0].max_uses, expected, `${depth} should allow ${expected}`);
  }
});

test('does not spend searches on asides below Deep', async () => {
  // Research is ~80% of the bill and an aside costs what the thesis costs,
  // while scoring weights it a third as much.
  const mixed = [
    { claim: 'Core claim.', quote: 'q', centrality: 'core' },
    { claim: 'Supporting claim.', quote: 'q', centrality: 'supporting' },
    { claim: 'An aside.', quote: 'q', centrality: 'aside' }
  ];

  const calls = captureFetch(RESEARCH_REPLY);
  const result = await researchClaims(settings({ researchDepth: 'standard' }), {
    claims: mixed,
    metadata: null
  });

  assert.equal(calls.length, 2, 'the aside must not reach the API');
  assert.equal(result.findings.length, 3, 'but it still gets a finding, in order');
  assert.equal(result.findings[2].skipped, true);
  assert.equal(result.findings[2].searches, 0);
  assert.match(result.findings[2].notes, /Not researched/);
});

test('researches asides once the depth is paid for', async () => {
  const mixed = [
    { claim: 'Core claim.', quote: 'q', centrality: 'core' },
    { claim: 'An aside.', quote: 'q', centrality: 'aside' }
  ];

  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ researchDepth: 'deep' }), { claims: mixed, metadata: null });

  assert.equal(calls.length, 2);
});

test('researches a claim whose centrality is missing', async () => {
  // Guessing that a claim is unimportant is the expensive mistake to get wrong.
  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ researchDepth: 'quick' }), {
    claims: [{ claim: 'Unlabelled.', quote: 'q' }],
    metadata: null
  });

  assert.equal(calls.length, 1);
});

test('skipped claims still report progress, so the count reaches its total', async () => {
  captureFetch(RESEARCH_REPLY);
  const seen = [];
  await researchClaims(settings({ researchDepth: 'standard' }), {
    claims: [
      { claim: 'a', quote: 'q', centrality: 'aside' },
      { claim: 'b', quote: 'q', centrality: 'core' }
    ],
    metadata: null,
    onProgress: (done, total) => seen.push(`${done}/${total}`)
  });

  assert.deepEqual(seen.sort(), ['1/2', '2/2']);
});

test('tells the judge a skipped claim was never looked up', async () => {
  // Otherwise it fills the gap from its own knowledge, which is the one thing
  // the judging stage must not do.
  const calls = captureFetch({
    content: [{ type: 'tool_use', name: 'record_verdicts', input: { verdicts: [], framing: 0, sourcing: 0 } }],
    usage: {}
  });

  await judgeClaims(settings(), {
    claims: [{ claim: 'An aside.' }],
    findings: [
      {
        index: 0,
        claim: 'An aside.',
        notes: 'Not researched: an aside, and this research depth covers core and supporting claims only.',
        sources: [],
        searches: 0,
        searchErrors: [],
        skipped: true
      }
    ]
  });

  const prompt = calls[0].body.messages[0].content;
  assert.match(prompt, /Not researched/);
  assert.match(prompt, /unverified/);
});

test('research depth is independent of effort', async () => {
  // They answer different questions — how many lookups, versus how hard to
  // think about what came back — so effort must not silently move the budget.
  const low = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ effort: 'low', researchDepth: 'deep' }), { claims, metadata: null });

  const high = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ effort: 'high', researchDepth: 'deep' }), { claims, metadata: null });

  assert.equal(low[0].body.tools[0].max_uses, 6);
  assert.equal(high[0].body.tools[0].max_uses, 6);
  assert.equal(low[0].body.output_config.effort, 'low');
  assert.equal(high[0].body.output_config.effort, 'high');
});

test('an unknown depth costs coverage, not the check', async () => {
  const calls = captureFetch(RESEARCH_REPLY);
  await researchClaims(settings({ researchDepth: 'nonsense' }), { claims, metadata: null });

  assert.equal(calls[0].body.tools[0].max_uses, 3, 'falls back to standard');
});

test('reports research progress so a long stage is not a silence', async () => {
  captureFetch(RESEARCH_REPLY);
  const seen = [];
  const three = Array.from({ length: 3 }, (_, i) => ({ claim: `C${i}`, quote: 'q' }));

  await researchClaims(settings(), {
    claims: three,
    metadata: null,
    onProgress: (done, total) => seen.push(`${done}/${total}`)
  });

  assert.deepEqual(seen, ['1/3', '2/3', '3/3']);
});

test('one claim failing does not sink the whole research stage', async () => {
  let call = 0;
  globalThis.fetch = async () => {
    call += 1;
    if (call === 2) return { ok: false, status: 529, statusText: 'Overloaded', json: async () => ({}) };
    return { ok: true, status: 200, json: async () => RESEARCH_REPLY };
  };

  const three = Array.from({ length: 3 }, (_, i) => ({ claim: `C${i}`, quote: 'q' }));
  const result = await researchClaims(settings(), { claims: three, metadata: null });

  assert.equal(result.findings.length, 3);
  const failed = result.findings.filter((f) => f.searchErrors.includes('request-failed'));
  assert.equal(failed.length, 1, 'the failure is recorded against its own claim');
  assert.match(failed[0].notes, /Research failed for this claim/);
  assert.equal(result.findings.filter((f) => f.sources.length).length, 2, 'the others still resolve');
});
