# YouFact

A browser extension that surfaces channel credibility on YouTube and gives you
one-click control over what gets recommended to you.

Status: early. The don't-recommend subsystem is built and verified against a
live session; the fact-check scoring and the button UI are not written yet.

## What exists

| Piece | File | What it does |
| --- | --- | --- |
| Token resolver | `Src/youtube/schema.js` | Finds feedback tokens by shape across both of YouTube's rendering architectures |
| Request signer | `Src/youtube/auth.js` | Builds the `SAPISIDHASH` header in-page, no `webRequest` permission |
| InnerTube client | `Src/youtube/innertube.js` | Posts to `/youtubei/v1/feedback` and checks per-token results |
| Token cache | `Src/core/tokenCache.js` | Per-channel token store, plus expiry telemetry |
| Blocklist | `Src/core/blocklist.js` | Local channel blocklist — the layer that cannot break |
| Deferred fire | `Src/core/dontRecommend.js` | Hides immediately, sends after an undo window |
| Canaries | `Src/core/canary.js` | Detects YouTube schema drift instead of failing silently |

`Docs/dont-recommend.md` records what was measured and how — read it before
changing anything in `Src/youtube/`.

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

## Poking at it

The extension has no UI yet. To drive the subsystem by hand, open devtools on
youtube.com and switch the console's context dropdown from `top` to the YouFact
content script, then:

```js
__youfact.stats()
// { cachedChannels: 23, blockedChannels: 0, pending: 0, expiry: [...] }

const { undo, settled } = __youfact.dontRecommend.request('UC…');
await undo();            // true if cancelled in time, false once sent
await settled;           // { outcome: 'undone' | 'sent' | 'failed' | 'local-only', … }
```

Requests are held for five seconds before being sent. That window is the only
undo that exists — YouTube's API returns no undo token.

## Two worlds

Chrome forces a split the code has to respect:

- `Src/page/harvester.js` runs in the MAIN world. It is the only place `ytcfg`,
  `ytInitialData` and element payloads are visible. It reads and posts, nothing else.
- `Src/content/index.js` runs in the ISOLATED world. It owns storage, decisions
  and the outbound request.

They talk over `Src/core/bridge.js`.

## Next

- Fact-check button UI (segmented pill; score badge with sample size)
- Don't-recommend button injection on thumbnails, watch page and Shorts rail
- Blocklist enforcement — hide blocked channels on every surface
- Claim extraction and scoring against a configurable model provider
