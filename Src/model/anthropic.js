/**
 * Anthropic provider.
 *
 * Runs in the service worker, never in a content script. The key must not sit
 * in a context that shares a document with YouTube, and keeping the call here
 * also means `chrome.storage.session` can later be locked to trusted contexts
 * without touching any of this.
 *
 * Three calls per check rather than one, because server-side web search needs
 * `tool_choice: auto` to be usable at all. So research runs free-form with
 * search enabled, and a separate cheap call with no search coerces the result
 * into schema.
 */

import { RESEARCH_DEPTHS } from '../core/settings.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Per-model request shape. The Messages API diverged across generations and
 * the differences are hard 400s, not warnings:
 *
 *   budget_tokens   removed on Opus 5, Sonnet 5 and Fable 5. Adaptive thinking
 *                   replaced it; depth is set by `output_config.effort`.
 *   effort          not accepted by Haiku 4.5.
 *   disabled        Fable 5 rejects an explicit `{type:'disabled'}` — thinking
 *                   is always on there, so the field is omitted instead.
 *   web_search      the 20260209 variant filters results before they reach the
 *                   context; it needs a 4.6-or-later model. Haiku 4.5 takes
 *                   the original.
 *
 * An unrecognised model is assumed to use the current shape, because that is
 * the direction new models move in.
 */
const MODEL_SHAPE = {
  'claude-opus-5': { adaptive: true, effort: true, canDisable: true, search: 'web_search_20260209' },
  'claude-sonnet-5': { adaptive: true, effort: true, canDisable: true, search: 'web_search_20260209' },
  'claude-fable-5': { adaptive: true, effort: true, canDisable: false, search: 'web_search_20260209' },
  'claude-haiku-4-5-20251001': {
    adaptive: false,
    effort: false,
    canDisable: true,
    search: 'web_search_20250305'
  }
};

const shapeFor = (model) => MODEL_SHAPE[model] ?? MODEL_SHAPE['claude-opus-5'];

/**
 * Search depth and output ceiling per effort tier. `maxTokens` stays at or
 * below 16k because these calls are not streamed and larger non-streaming
 * responses run into HTTP timeouts; it also has to cover thinking, which is
 * billed against the same ceiling.
 */
const EFFORT = {
  low: { effort: 'low', legacyBudget: 0, maxTokens: 8000 },
  medium: { effort: 'medium', legacyBudget: 4000, maxTokens: 12000 },
  high: { effort: 'high', legacyBudget: 10000, maxTokens: 16000 }
};

/** Falls back rather than throwing: a bad depth should cost coverage, not the check. */
const searchesPerClaim = (settings) =>
  (RESEARCH_DEPTHS[settings.researchDepth] ?? RESEARCH_DEPTHS.standard).searchesPerClaim;

/**
 * Claims researched at once.
 *
 * Each claim is its own request, so this is the only thing standing between a
 * twelve-claim video and twelve simultaneous requests against the user's rate
 * limit.
 */
const RESEARCH_CONCURRENCY = 4;

/** Map with a ceiling on how many are in flight at once. */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Only the research stage is given thinking explicitly. The other two force a
 * tool choice, and disabling thinking on a tool-forced call is the one
 * configuration known to make a model write its tool call into the visible
 * text instead of emitting it — the turn succeeds, the call never runs, and
 * the stage reports no claims. So `auto` leaves those stages at the model's
 * own default rather than turning thinking off to save tokens.
 *
 * `off` is still honoured everywhere, because the user asked for it.
 */
function thinkingFor(settings, stage) {
  const shape = shapeFor(settings.model);

  if (settings.thinking === 'off') {
    return shape.canDisable ? { type: 'disabled' } : null;
  }
  if (settings.thinking === 'auto' && stage !== 'research') return null;

  if (shape.adaptive) return { type: 'adaptive' };
  const budget = EFFORT[settings.effort].legacyBudget;
  return budget ? { type: 'enabled', budget_tokens: budget } : null;
}

async function postOnce(settings, { system, messages, tools, toolChoice, thinking, maxTokens }) {
  const shape = shapeFor(settings.model);
  const tier = EFFORT[settings.effort];

  const body = {
    model: settings.model,
    max_tokens: maxTokens ?? tier.maxTokens,
    system,
    messages
  };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (thinking) body.thinking = thinking;
  if (shape.effort) body.output_config = { effort: tier.effort };
  if (thinking?.type === 'enabled') {
    // Legacy models only: the budget must fit inside max_tokens with room left
    // for the answer itself.
    body.max_tokens = Math.max(body.max_tokens, thinking.budget_tokens + 4000);
  }

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(`${response.status} ${detail?.error?.message ?? response.statusText}`);
  }

  const message = await response.json();

  // A refusal arrives as a successful 200 with empty or partial content, so
  // reading the content blocks without checking first turns it into "no
  // claims found" — a claim about the video rather than about the request.
  if (message.stop_reason === 'refusal') {
    const category = message.stop_details?.category ?? 'unspecified';
    throw new Error(`the model declined this request (${category})`);
  }

  return message;
}

/** A paused turn is resumed at most this many times before we take what we have. */
const MAX_CONTINUATIONS = 4;

const addUsage = (total, usage) => ({
  input_tokens: (total.input_tokens ?? 0) + (usage?.input_tokens ?? 0),
  output_tokens: (total.output_tokens ?? 0) + (usage?.output_tokens ?? 0)
});

/**
 * One logical turn, however many round trips the server needs.
 *
 * Server-side tools run their own sampling loop, and when it hits its
 * iteration limit the turn comes back with `stop_reason: 'pause_turn'` and
 * only the work done so far — the searches have run, but the model has not
 * written its findings yet. Returning that as if it were finished is what made
 * every claim come back "unverified, no sources": the searches happened, the
 * results were thrown away, and the judge was handed an empty page.
 *
 * Resuming means echoing the assistant turn back untouched. Adding a "continue"
 * message of our own derails the server's own loop.
 */
async function callMessages(settings, request) {
  const conversation = [...request.messages];
  const content = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  let message;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt += 1) {
    message = await postOnce(settings, { ...request, messages: conversation });
    content.push(...(message.content ?? []));
    usage = addUsage(usage, message.usage);

    if (message.stop_reason !== 'pause_turn') break;
    conversation.push({ role: 'assistant', content: message.content });
  }

  // The accumulated content is the whole turn; the last response only carries
  // its own slice of it.
  return { ...message, content, usage };
}

const textOf = (message) =>
  (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

const toolResultOf = (message, name) =>
  (message.content ?? []).find((block) => block.type === 'tool_use' && block.name === name)?.input ?? null;

/**
 * Everything the search actually surfaced, kept verbatim for citation.
 *
 * Two places carry sources and they do not always agree. Citations hang off
 * the text the model wrote, so they cover what it chose to lean on; the search
 * result blocks cover what it was shown. Harvesting only the first loses every
 * source in a turn whose prose came back unannotated, which reads downstream
 * as "no sources settled this claim" even though the search worked.
 */
function sourcesFrom(message) {
  const seen = new Set();
  const sources = [];

  const add = (url, title) => {
    if (!url || seen.has(url)) return;
    seen.add(url);
    sources.push({ url, title: title || url });
  };

  for (const block of message.content ?? []) {
    for (const citation of block.citations ?? []) add(citation.url, citation.title);

    if (block.type !== 'web_search_tool_result') continue;
    // On success `content` is a list of results; on failure it is a single
    // error object. Indexing without checking turns a search error into a
    // crash.
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) add(result.url, result.title);
  }

  return sources;
}

/**
 * Why a search produced nothing, when it produced nothing.
 *
 * `max_uses_exceeded` and friends arrive as a successful turn with an error
 * object where the results should be, so without this they are invisible and
 * indistinguishable from "nothing was found".
 */
function searchErrorsOf(message) {
  const errors = [];
  for (const block of message.content ?? []) {
    if (block.type !== 'web_search_tool_result') continue;
    if (Array.isArray(block.content)) continue;
    const code = block.content?.error_code;
    if (code) errors.push(code);
  }
  return [...new Set(errors)];
}

/** How many searches the model actually ran, as opposed to was allowed to. */
const searchCountOf = (message) =>
  (message.content ?? []).filter(
    (block) => block.type === 'server_tool_use' && block.name === 'web_search'
  ).length;

const CLAIMS_TOOL = {
  name: 'record_claims',
  description: 'Record the checkable factual claims found in the transcript.',
  input_schema: {
    type: 'object',
    properties: {
      claims: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            timestampMs: { type: 'integer', description: 'Start of the passage the claim came from' },
            quote: { type: 'string', description: 'The speaker’s own words, verbatim and trimmed' },
            claim: { type: 'string', description: 'The claim restated as one checkable sentence' },
            centrality: {
              type: 'string',
              enum: ['core', 'supporting', 'aside'],
              description: 'How load-bearing the claim is to the video’s argument'
            }
          },
          required: ['timestampMs', 'quote', 'claim', 'centrality']
        }
      }
    },
    required: ['claims']
  }
};

const VERDICTS_TOOL = {
  name: 'record_verdicts',
  description: 'Record a verdict for each claim, citing only sources from the research notes.',
  input_schema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', description: 'Index of the claim being judged' },
            verdict: {
              type: 'string',
              enum: ['supported', 'contradicted', 'misleading', 'unverified']
            },
            confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
            reasoning: { type: 'string', description: 'Two sentences at most. State the finding, not the process.' },
            sourceUrls: { type: 'array', items: { type: 'string' } }
          },
          required: ['index', 'verdict', 'confidence', 'reasoning', 'sourceUrls']
        }
      },
      framing: {
        type: 'integer',
        description: '0-100. How fairly the video frames what it reports, separate from factual accuracy.'
      },
      sourcing: {
        type: 'integer',
        description: '0-100. How well the video attributes its own claims to sources.'
      }
    },
    required: ['verdicts', 'framing', 'sourcing']
  }
};

const EXTRACT_SYSTEM = `You extract checkable factual claims from video transcripts.

A checkable claim asserts something about the world that evidence could confirm or refute: numbers, events, attributions, causal assertions, statements about what someone said or did.

Never extract: opinions, predictions, hypotheticals, jokes, rhetorical questions, statements of preference, or anything whose truth depends on definitions the speaker is free to choose.

Transcripts are auto-generated and contain errors. If a passage is too garbled to be sure what was asserted, skip it rather than guessing.

Prefer claims that matter to the video's argument over trivia that happens to be checkable.`;

const RESEARCH_SYSTEM = `You research one factual claim using web search, then report what you found.

Always search before answering. Do not answer from your own knowledge — your knowledge has a cutoff, the claim may concern events after it, and a verdict reached without a source cannot be cited. Search even when you believe you already know the answer.

Search more than once when the first query is unhelpful: try the specific figure, the entity's own materials, and the trade or specialist press covering that field.

Prefer primary sources, official records, regulatory filings, technical documentation from the manufacturer or standards body, peer-reviewed work and established outlets over aggregators, forums, content farms and commentary. Note publication dates — a claim can be true of one period and false of another, and specifications and prices move.

Report what the sources actually say, naming each one. Say plainly whether they support the claim, contradict it, or settle only part of it. Include disagreement between sources rather than picking a side. Do not reach a verdict and do not soften findings to be agreeable. If you searched and genuinely found nothing usable, say that and say what you searched for.`;

const JUDGE_SYSTEM = `You turn research notes into per-claim verdicts.

Each claim arrives with its own research and its own list of available source URLs. Judge each claim only against the research filed under it, and cite only URLs from that claim's own list.

Do not introduce facts from your own knowledge. If the research supports a verdict, give it — do not retreat to "unverified" because the evidence is indirect or partial. Reserve "unverified" for claims whose research genuinely did not settle them, and say what was missing.

- supported: the sources confirm the claim as stated
- contradicted: the sources directly conflict with the claim
- misleading: literally defensible but creates a false impression through omission or framing
- unverified: the research did not settle it — this is a normal outcome, not a failure

Judge the claim as the speaker meant it, not an uncharitable reading of the words. Being unable to verify something is not evidence against it.`;

export async function extractClaims(settings, { passages, metadata, maxClaims }) {
  const transcript = passages
    .map((passage) => `[${passage.startMs}] (${passage.timestamp}) ${passage.text}`)
    .join('\n\n');

  const message = await callMessages(settings, {
    system: EXTRACT_SYSTEM,
    tools: [CLAIMS_TOOL],
    toolChoice: { type: 'tool', name: CLAIMS_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `Video: ${metadata?.title ?? 'unknown'}\nChannel: ${metadata?.author ?? 'unknown'}\n\n` +
          `Extract at most ${maxClaims} checkable claims from this transcript. ` +
          `Each passage is prefixed with its start time in milliseconds — use that for timestampMs.\n\n${transcript}`
      }
    ]
  });

  const result = toolResultOf(message, CLAIMS_TOOL.name);
  return {
    claims: (result?.claims ?? []).slice(0, maxClaims),
    usage: message.usage
  };
}

/**
 * Research every claim, one request each.
 *
 * This used to be a single call covering all of them against one shared search
 * budget — six searches for twelve claims at medium effort. Even when it
 * worked, most claims could not have been looked up, and the model spent the
 * budget on whichever ones it found interesting. Per-claim requests are the
 * only way "find sources for this claim" is a question actually asked about
 * each claim.
 *
 * A claim whose research throws does not sink the stage: it comes back with no
 * sources and the reason recorded, and the judge marks it unverified.
 *
 * @param {{onProgress?: (done: number, total: number) => void}} options
 */
export async function researchClaims(settings, { claims, metadata, onProgress = () => {} }) {
  const searchTool = {
    type: shapeFor(settings.model).search,
    name: 'web_search',
    max_uses: searchesPerClaim(settings)
  };

  const about =
    `The claim was made in a video titled "${metadata?.title ?? 'unknown'}" ` +
    `by ${metadata?.author ?? 'unknown'}.`;

  let done = 0;

  const findings = await mapLimited(claims, RESEARCH_CONCURRENCY, async (claim, index) => {
    try {
      const message = await callMessages(settings, {
        system: RESEARCH_SYSTEM,
        thinking: thinkingFor(settings, 'research'),
        tools: [searchTool],
        messages: [
          {
            role: 'user',
            content:
              `${about}\n\nClaim to research:\n"${claim.claim}"\n\n` +
              `The speaker's own words were: "${claim.quote}"\n\n` +
              'Search for evidence bearing on this claim and report what you find.'
          }
        ]
      });

      return {
        index,
        claim: claim.claim,
        notes: textOf(message),
        sources: sourcesFrom(message),
        searches: searchCountOf(message),
        searchErrors: searchErrorsOf(message),
        usage: message.usage
      };
    } catch (error) {
      return {
        index,
        claim: claim.claim,
        notes: `Research failed for this claim: ${String(error?.message ?? error)}`,
        sources: [],
        searches: 0,
        searchErrors: ['request-failed'],
        usage: null
      };
    } finally {
      done += 1;
      onProgress(done, claims.length);
    }
  });

  // One deduped pool so a verdict citing a url can be resolved to its title
  // regardless of which claim's research turned it up.
  const pool = new Map();
  for (const finding of findings) {
    for (const source of finding.sources) if (!pool.has(source.url)) pool.set(source.url, source);
  }

  return {
    findings,
    sources: [...pool.values()],
    searches: findings.reduce((total, finding) => total + finding.searches, 0),
    usage: findings.reduce((total, finding) => addUsage(total, finding.usage), {
      input_tokens: 0,
      output_tokens: 0
    })
  };
}

/** One claim, its research and the urls that verdict may cite. */
function dossier(finding) {
  const sources = finding.sources.length
    ? finding.sources.map((source) => `  - ${source.url} — ${source.title}`).join('\n')
    : '  (none)';

  return (
    `### Claim ${finding.index}\n${finding.claim}\n\n` +
    `Searches run: ${finding.searches}` +
    (finding.searchErrors.length ? ` (errors: ${finding.searchErrors.join(', ')})` : '') +
    `\n\nFindings:\n${finding.notes || '(the research stage returned nothing)'}\n\n` +
    `Sources available to cite for this claim:\n${sources}`
  );
}

export async function judgeClaims(settings, { claims, findings }) {
  const message = await callMessages(settings, {
    system: JUDGE_SYSTEM,
    tools: [VERDICTS_TOOL],
    toolChoice: { type: 'tool', name: VERDICTS_TOOL.name },
    messages: [
      {
        role: 'user',
        content:
          `Judge each of these ${claims.length} claims against its own research.\n\n` +
          `${findings.map(dossier).join('\n\n')}`
      }
    ]
  });

  const result = toolResultOf(message, VERDICTS_TOOL.name);
  return {
    verdicts: result?.verdicts ?? [],
    framing: result?.framing ?? null,
    sourcing: result?.sourcing ?? null,
    usage: message.usage
  };
}
