# What a check costs, and why

Rates confirmed against the Claude platform docs on 2026-08-12. The token
breakdown is a **model**, not a measurement — the arithmetic below reproduces
an observed $3.88 check to within about 20%, but it has not been checked
against a usage export. See [Measuring a real check](#measuring-a-real-check)
to replace it with facts.

## Rates

| Item | Rate |
| --- | --- |
| Claude Sonnet 5 | $2 / MTok input, $10 / MTok output |
| Claude Opus 5 | $5 / MTok input, $25 / MTok output |
| Claude Haiku 4.5 | $1 / MTok input, $5 / MTok output |
| Web search | **$10 per 1,000 searches** ($0.01 each), plus tokens |
| Prompt cache | write 1.25×, read 0.1× |
| Batch API | 50% off tokens; searches unchanged |

Citations are free: `cited_text`, `title` and `url` on a
`web_search_result_location` do not count toward input or output tokens.

## The thing that actually costs money

From the web search tool docs, emphasis added:

> Web search results retrieved throughout a conversation are counted as input
> tokens, **in search iterations executed during a single turn** and in
> subsequent conversation turns.

The server runs its own sampling loop inside one request. Each iteration is
billed the whole conversation so far — including every search result already
returned. So the *n*th search is not paid for once; it is paid for again on
every iteration after it.

For a claim researched with `s` searches, where each search adds `R` tokens of
filtered results, input billed for that one claim is roughly:

```
(s + 1) · P  +  R · s(s + 1)/2
```

`P` is the prompt, a few hundred tokens and irrelevant. The second term is
everything, and it is **quadratic in the search budget**.

Depths as shipped, priced for 12 claims on Sonnet 5 by `Src/core/cost.js`:

| Depth | `max_uses` | Relative token cost | Ceiling, 12 claims | Asides |
| --- | ---: | ---: | ---: | --- |
| Quick | 2 | 3 units | $1.51 | skipped |
| Standard | 3 | 6 units | $2.49 | skipped |
| Deep | 6 | 21 units | $7.17 | researched |
| Exhaustive | 10 | 55 units | $17 | researched |

> **Fixed.** The options page used to state this ceiling as a *search count* —
> "up to 180 web searches per video" at the old Exhaustive. Read as search fees
> that implies $1.80, against a real figure near $40: the hint understated it
> by more than tenfold, because the fees are not the cost. Depth labels and the
> hint now both carry an estimated ceiling in money, priced for the selected
> model and claim count.

## Where $3.88 went

A ~60 minute video, 12 claims, Standard depth, Sonnet 5, medium effort:

| Stage | Calls | Est. input | Est. output | Searches | Est. cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Extract | 1 | ~15k | ~3k | – | $0.06 |
| Research | 12 | **~1.1M** | ~30k | 48 | **$2.99** |
| Judge | 1 | ~8k | ~3k | – | $0.05 |
| | | | | | **~$3.10** |

Research is **~80% of the bill**, and within it the re-billed search results
are ~75%. Search fees are only about 12% of the total; the transcript, the
claim extraction and the judging together are under 4%.

The practical consequence: **optimising anything other than research input
tokens is rounding error.**

## Levers, ranked

### 1. Lower the default depth — **done**

Because cost goes as `s²`, trimming the budget pays more than it looks.
Standard went from 4 searches to 3, which removes ~40% of research tokens.
Anthropic's own guidance is that "simple factual queries typically use 1–3
searches", and most checkable claims are simple factual lookups. Deep and
Exhaustive came down from 8 and 15 to 6 and 10, since the old top of the ladder
priced a single video near $40 without saying so.

### 2. Do not research every claim — **done**

Claims carry a `centrality` of `core`, `supporting` or `aside`, and scoring
weights them 3 / 2 / 1. Researching an aside costs exactly what researching the
thesis costs and moves the score least. Below Deep, asides are extracted and
listed but not searched for — the panel marks them "Not researched" rather than
letting a deliberate skip read as a failed search, and the judge is told
explicitly that nothing was gathered so it marks them unverified instead of
answering from its own knowledge.

A claim with no centrality at all is researched. Guessing that something is
unimportant is the expensive mistake to get wrong.

**Combined effect:** the observed $3.88 check estimates at **$1.70** under the
new defaults, a 56% reduction, before any of the levers below.

### 3. Prompt caching — potentially the largest win, unverified

The growing prefix inside a research turn is exactly what caching exists for,
and cache reads are 0.1×. If `cache_control` applies across the server-side
loop's iterations, the quadratic term largely collapses.

**Whether it does is unknown and needs an experiment**, since the loop is run
by the server rather than by us. Sonnet 5's minimum cacheable prefix is 512
tokens, which the conversation clears after the first search. Verify by
watching `cache_read_input_tokens` on a research call.

### 4. Batch API — 50% off tokens, async only

Web searches stay full price, so this takes a $3.88 check to roughly $2.20.
Results can take up to 24 hours, so it suits automatic background checking, not
the button.

### 5. `web_search_20260318` + `response_inclusion: "excluded"` — small

Newer than the `20260209` currently used. Dropping echoed search blocks from
the response cuts *output* tokens, which are only ~10% of the bill. It also
removes the `web_search_tool_result` blocks that `sourcesFrom` harvests
non-cited sources from, so "also consulted" would be lost. Citations survive
and are free. Worth it for the tool upgrade, not for the savings.

### 6. A cheaper model for research — **do not**

Haiku 4.5 is half Sonnet 5's price, and research is a summarise-what-you-found
task well within its range. But Haiku does not support dynamic filtering, so it
must use basic `web_search_20250305`, where "every search result is loaded into
Claude's context window" unfiltered. Half the rate against a multiple of the
tokens is very likely a net loss on the one stage that dominates. The current
`web_search_20260209` on Sonnet 5 is the cheaper combination.

## Measuring a real check

The record already stores per-stage usage. On a watch page, in the YouFact
content-script console:

```js
const r = __youfact.checks.getVideo(new URLSearchParams(location.search).get('v'));
console.table(r.usage);                                   // per stage
r.claims.reduce((n, c) => n + (c.searches ?? 0), 0);      // searches actually run
```

Two gaps to close before this is a real cost readout:

- `researchClaims` sums only `input_tokens` and `output_tokens`, dropping
  `cache_creation_input_tokens` and `cache_read_input_tokens` — so caching
  cannot currently be verified from a record.
- `usage.server_tool_use.web_search_requests` is the authoritative search count
  and is not recorded at all. Counting `server_tool_use` blocks, as
  `searchCountOf` does, breaks under `response_inclusion: "excluded"`.
