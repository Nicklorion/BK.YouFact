/**
 * Anthropic provider.
 *
 * Runs in the service worker, never in a content script. The key must not sit
 * in a context that shares a document with YouTube, and keeping the call here
 * also means `chrome.storage.session` can later be locked to trusted contexts
 * without touching any of this.
 *
 * Three calls per check rather than one, because the constraints force it:
 * extended thinking cannot be combined with a forced tool choice, and server
 * side web search needs `tool_choice: auto` to be usable at all. So research
 * runs free-form with search enabled, and a separate cheap call with no
 * thinking and no search coerces the result into schema.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Reasoning budget and search depth per effort tier. */
const EFFORT = {
  low: { thinkingBudget: 0, maxSearches: 3, maxTokens: 4000 },
  medium: { thinkingBudget: 4000, maxSearches: 6, maxTokens: 8000 },
  high: { thinkingBudget: 10000, maxSearches: 12, maxTokens: 16000 }
};

function thinkingFor(settings, stage) {
  const budget = EFFORT[settings.effort].thinkingBudget;
  if (!budget) return null;
  if (settings.thinking === 'off') return null;
  // `auto` spends reasoning only where it changes the answer.
  if (settings.thinking === 'auto' && stage !== 'research') return null;
  return { type: 'enabled', budget_tokens: budget };
}

async function callMessages(settings, { system, messages, tools, toolChoice, thinking, maxTokens }) {
  const body = {
    model: settings.model,
    max_tokens: maxTokens ?? EFFORT[settings.effort].maxTokens,
    system,
    messages
  };
  if (tools) body.tools = tools;
  if (toolChoice) body.tool_choice = toolChoice;
  if (thinking) {
    body.thinking = thinking;
    // The budget must fit inside max_tokens with room for the answer.
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
  return response.json();
}

const textOf = (message) =>
  (message.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

const toolResultOf = (message, name) =>
  (message.content ?? []).find((block) => block.type === 'tool_use' && block.name === name)?.input ?? null;

/** Sources the server-side search actually visited, kept verbatim for citation. */
function citationsOf(message) {
  const seen = new Set();
  const sources = [];
  for (const block of message.content ?? []) {
    for (const citation of block.citations ?? []) {
      const url = citation.url;
      if (!url || seen.has(url)) continue;
      seen.add(url);
      sources.push({ url, title: citation.title ?? url });
    }
  }
  return sources;
}

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

const RESEARCH_SYSTEM = `You research factual claims using web search, then report what you found.

Search for each claim. Prefer primary sources, official records and established outlets over aggregators and commentary. Note publication dates — a claim can be true of one period and false of another.

Report what the sources say, including where they disagree or where you could not find anything. Do not reach a verdict yet and do not soften findings to be agreeable. If the evidence is thin, say it is thin.`;

const JUDGE_SYSTEM = `You turn research notes into per-claim verdicts.

Use only the research notes. Do not introduce facts from your own knowledge, and cite only URLs that appear in the notes.

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

export async function researchClaims(settings, { claims, metadata }) {
  const list = claims.map((claim, index) => `${index}. ${claim.claim}`).join('\n');

  const message = await callMessages(settings, {
    system: RESEARCH_SYSTEM,
    thinking: thinkingFor(settings, 'research'),
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: EFFORT[settings.effort].maxSearches
      }
    ],
    messages: [
      {
        role: 'user',
        content:
          `These claims were made in a video titled "${metadata?.title ?? 'unknown'}" ` +
          `by ${metadata?.author ?? 'unknown'}.\n\nResearch each one and report your findings.\n\n${list}`
      }
    ]
  });

  return { notes: textOf(message), sources: citationsOf(message), usage: message.usage };
}

export async function judgeClaims(settings, { claims, notes }) {
  const list = claims.map((claim, index) => `${index}. ${claim.claim}`).join('\n');

  const message = await callMessages(settings, {
    system: JUDGE_SYSTEM,
    tools: [VERDICTS_TOOL],
    toolChoice: { type: 'tool', name: VERDICTS_TOOL.name },
    messages: [
      { role: 'user', content: `Claims:\n${list}\n\nResearch notes:\n${notes}` }
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
