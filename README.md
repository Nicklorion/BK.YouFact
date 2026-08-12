# YouFact

A browser extension that surfaces channel credibility on YouTube and gives you
one-click control over what gets recommended to you.

**Status: first release candidate — `1.0.0-rc.1`.**

Both subsystems are built and the fact-check pipeline runs end to end on a real
video: transcript, claims, per-claim research with cited sources, verdicts,
score. It is a release *candidate* rather than a release because of what has
not been verified rather than what is missing — see [Known limits](#known-limits).

Everything runs locally against your own API key. Nothing is uploaded, and
there is no server.

## What exists

### Fact-checking

| Piece | File | What it does |
| --- | --- | --- |
| Transcripts | `Src/youtube/transcriptApi.js` | The route that runs: `get_panel` with a constructed `params`, no UI, no sign-in, no `ytcfg` |
| Transcript fallbacks | `Src/youtube/transcript.js` | Panel parsing and the click-the-button routes — read its header before touching it |
| Provider | `Src/model/anthropic.js` | Claim extraction, per-claim research with web search, judging; per-model request shapes |
| Pipeline | `Src/background/worker.js` | Runs the stages in the service worker, the only place the API key is read |
| Scoring | `Src/core/scoring.js` | Arithmetic over verdicts — no model, so the number is reproducible |
| Check store | `Src/core/checkStore.js` | Per-video records and the channel rollup |
| Pill and panel | `Src/ui/factCheck.js` | The gauge, the claim list, and the three levels of disclosure |

### Recommendation control

| Piece | File | What it does |
| --- | --- | --- |
| Token resolver | `Src/youtube/schema.js` | Finds feedback tokens by shape across both of YouTube's rendering architectures |
| Request signer | `Src/youtube/auth.js` | Builds the `SAPISIDHASH` header in-page, no `webRequest` permission |
| InnerTube client | `Src/youtube/innertube.js` | Posts to `/youtubei/v1/feedback` and checks per-token results |
| Token cache | `Src/core/tokenCache.js` | Per-channel token store, plus expiry telemetry |
| Blocklist | `Src/core/blocklist.js` | Local channel blocklist — the layer that cannot break |
| Deferred fire | `Src/core/dontRecommend.js` | Hides immediately, sends after an undo window |
| Canaries | `Src/core/canary.js` | Detects YouTube schema drift instead of failing silently |
| Injection | `Src/ui/anchors.js`, `Src/ui/inject.js` | Mounts controls on watch page, feed cards and the Shorts rail |
| Enforcement | `Src/ui/enforce.js` | Hides blocked channels by CSS, keyed off stamped attributes |
| Undo toast | `Src/ui/toast.js` | The countdown that makes the deferred fire reversible |

### Shared

| Piece | File | What it does |
| --- | --- | --- |
| Settings | `Src/core/settings.js`, `Src/options/` | Provider, key, model, effort, thinking, research depth; key stored locally only |
| World bridge | `Src/core/bridge.js` | The namespaced `postMessage` channel between the two content-script worlds |
| Storage | `Src/core/storage.js` | Promise wrapper over `chrome.storage.local`, with an in-memory fallback so modules stay testable |

`Docs/dont-recommend.md` records what was measured about the endpoint;
`Docs/ui-injection.md` records the anchors and the DOM traps. Read both before
changing anything in `Src/youtube/` or `Src/ui/`.

## Design in one paragraph

Fact-checking is expensive; the user's own API key pays for it. The shared index
is therefore not a service but a distributed memoization cache over checks
people have already paid for — each check is done once and benefits everyone who
later watches that video. v1 runs entirely locally so the record schema can stop
moving before it becomes public.

## Build

```bash
npm install
npm run build
```

Load `Dist/` as an unpacked extension in Brave or Chrome
(`chrome://extensions` → Developer mode → Load unpacked). `npm run watch`
rebuilds on change; reload the extension to pick up changes.

```bash
npm test
```

## Using it

### Fact-checking a video

The pill sits beside Like on the watch page. It shows a gauge: an arc filled in
proportion to the credibility score, red through amber to green, with the
number in the cup and the sample size beside it.

Click **Fact-check** to run a check. The label reports the stage, the
per-claim progress and the elapsed time (`Researching claims · 5/12 · 47s`),
and the button is disabled while it runs — a second click would abandon the run
in flight and pay for another. Click **Details** afterwards for the claim list;
click any claim for the quote, the reasoning and the sources.

Nothing runs until you ask. Every check spends your own API credit, so
automatic checking is off by default.

### Recommendation control

A "Don't recommend" control appears in three places: under the video on the
watch page, on hover over any feed or sidebar card, and on the Shorts rail.
Clicking it hides the channel immediately and shows a five-second undo. Once
that window closes the request goes to YouTube and cannot be taken back — the
API returns no undo token.

Blocked channels stay hidden across every surface, including videos that load
later via infinite scroll.

## Poking at it

To drive the subsystem by hand, open devtools on youtube.com and switch the
console's context dropdown from `top` to the YouFact content script, then:

```js
__youfact.stats()
// { cachedChannels: 23, blockedChannels: 0, checkedVideos: 4, pending: 0, expiry: [...] }

__youfact.running        // video id of the check in flight, or null
__youfact.lastFailure    // why the last check died: stage, elapsed, provider message

const { undo, settled } = __youfact.dontRecommend.request('UC…');
await undo();            // true if cancelled in time, false once sent
await settled;           // { outcome: 'undone' | 'sent' | 'failed' | 'local-only', … }
```

Requests are held for five seconds before being sent. That window is the only
undo that exists — YouTube's API returns no undo token.

When a check fails, the pill shows a short reason and the full one on hover —
the stage it died in, how long it ran, and the provider's own message. The
model calls happen in the service worker, so its console (`brave://extensions`
→ YouFact → service worker) is where provider errors surface.

## Two worlds

Chrome forces a split the code has to respect:

- `Src/page/harvester.js` runs in the MAIN world. It is the only place `ytcfg`,
  `ytInitialData` and element payloads are visible. It reads and posts, nothing else.
- `Src/content/index.js` runs in the ISOLATED world. It owns storage, decisions
  and the outbound request.

They talk over `Src/core/bridge.js`.

## Settings

Click the YouFact toolbar icon, or right-click it and choose Options. Provider,
API key, model, effort and thinking live there, along with the claim budget.
Use Test to verify the key before relying on it.

Two settings decide what a check costs, and they multiply:

- **Claims per video** — how many claims are extracted at all.
- **How hard to verify each claim** — web searches per claim, from Quick (2) to
  Exhaustive (10). Separate from effort, which buys reasoning rather than
  lookups. A claim only earns a citable verdict if its search finds something,
  so this is what decides how many come back unverified.

Depth is not linear in cost. Search results are re-billed on every later search
in the same request, so the bill goes as roughly the square of the budget —
doubling it closer to triples the cost. Both the depth labels and the hint
state an estimated ceiling in money for the model and claim count you have
selected; twelve claims at Standard on Sonnet 5 is about $1.70 in practice.
`Docs/cost.md` has the arithmetic.

Below Deep, claims the model marked as asides are extracted and listed but not
researched — an aside costs the same to check as the thesis and moves the score
least.

Checks never run automatically unless you turn that on. Every check costs money,
so the default is that YouFact does nothing until asked.

## How a check works

Five stages, in the service worker:

1. **Transcribe** — segments and timestamps, grouped into ~45s passages.
   `/youtubei/v1/get_panel` answers for any video id with no sign-in, no
   cookies and no `ytcfg`, all four measured; the panel-driving routes in
   `transcript.js` are only there for when that stops being true
2. **Extract claims** — checkable assertions only; opinion and prediction dropped
3. **Research** — one request per claim, each with its own web-search budget,
   sources captured verbatim. Sharing one budget across every claim meant most
   claims could not be looked up at all, so they all came back unverified
4. **Judge** — a verdict per claim, citing only sources from stage 3
5. **Score** — arithmetic over verdicts, no model, fully reproducible

The gauge shows one number and never without its sample size. Two counts appear
and they are different on purpose: the score is computed over claims the
evidence actually **settled**, so a video with twelve claims and three
unverified reads `9 of 12 judged`. Unverified claims are excluded from accuracy
rather than counted against it — failing to find evidence is not evidence of
falsehood, and counting it as such would punish videos about obscure subjects.

Below 6 judged claims the gauge drops its gradient for flat grey and the
caption says "thin". Colour is never the only signal anywhere in this UI:
verdicts carry a word, scores carry a count.

## Known limits

What keeps this a candidate rather than a release. None of these are unknown
unknowns — they are the things worth knowing before relying on it.

- **One provider.** Anthropic only. The settings page is built around a
  provider table, but nothing else has been wired to it.
- **One measured client.** Every YouTube route here was measured against web
  client `2.20260811.01.00`. The canaries report drift rather than silently
  failing, but drift will still break things.
- **Cost scales with two multiplied settings.** Claims per video × searches per
  claim. Twelve claims at Standard is up to 48 web searches for one video. The
  options page states the ceiling; there is no spend cap.
- **A long check depends on a heartbeat.** The service worker is kept alive by
  talking over the port every 20 seconds, because a pending `fetch` does not
  reset its idle timer. A check that outlives the browser's own ceiling will
  still end in `background worker stopped`.
- **A high score can rest on a small sample.** Accuracy is computed over judged
  claims and excludes unverified ones, so a video where research settles little
  can still score well off a handful. Thin evidence is marked — grey gauge,
  the word "thin", and the judged-of-total count — but it is not penalised.
- **The score is a summary, not a verdict.** It is reproducible arithmetic over
  model judgements, which makes it auditable, not authoritative. The claim list
  is the actual output; the number is an index into it.

## Next

- A spend cap, and a per-check cost estimate before the request goes out
- Channel-level checking beyond aggregating per-video scores
- The shared index (v2) once the record schema stops moving
- Comment reply drafting, grounded in the evidence already fetched
