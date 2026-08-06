# "Don't recommend channel" — measured behaviour

Everything here was measured against a live signed-in session on YouTube web
client `2.20260805.01.00`. Where something is inferred rather than observed it
says so. Re-run the canaries (`Src/core/canary.js`) when the client version
moves and update this file with what changed.

## Two schemas, one action

YouTube ships two rendering architectures side by side and expresses the same
menu differently in each.

Legacy — `ytd-video-renderer`, seen on search results. The element exposes its
whole payload at `element.data`:

```
menu.menuRenderer.items[].menuServiceItemRenderer
  .icon.iconType                                   -> icon enum
  .serviceEndpoint.feedbackEndpoint.feedbackToken   -> token
```

Modern — `lockupViewModel`, seen on the home feed and watch sidebar. `.data` is
a symbol; the payload is behind a signal accessor at `element.rawProps.data()`:

```
metadata.lockupMetadataViewModel.menuButton.buttonViewModel.onTap.innertubeCommand
  .showSheetCommand.panelLoadingStrategy.inlineContent.sheetViewModel.content
  .listViewModel.listItems[].listItemViewModel
    .title.content                                        -> localized label
    .leadingImage.sources[0].clientResource.imageName      -> icon enum
    .rendererContext.commandContext.onTap.innertubeCommand
      .feedbackEndpoint.feedbackToken                      -> token
```

Both are present in the page payload. Neither requires opening the menu and
neither triggers a network round-trip — an earlier assumption that the menu was
lazy-loaded turned out to be an artefact of testing signed out. Signed-out
sessions receive no feedback items at all.

## Icon enums are the discriminator

Never match on the visible label: it is localized into 80+ languages
(`Kanaal niet aanbevelen`, `Don't recommend channel`, …). The icon enum is
stable and locale-independent.

| Action | Legacy | Modern |
| --- | --- | --- |
| Don't recommend channel | `REMOVE` | `REMOVE` |
| Not interested | `NOT_INTERESTED` | `HIDE` |

`REMOVE` holds across both. `NOT_INTERESTED` does not — it was renamed to
`HIDE` in the modern schema, which is a live example of this enum drifting.

Full menu observed on a home-feed video:

| Label | Icon | Endpoint | Token |
| --- | --- | --- | --- |
| Add to queue | `ADD_TO_QUEUE_TAIL` | `signalServiceEndpoint` | — |
| Save to Watch later | `WATCH_LATER` | `playlistEditEndpoint` | — |
| Save to playlist | `BOOKMARK_BORDER` | `showSheetCommand` | — |
| Share | `SHARE` | `shareEntityServiceEndpoint` | — |
| Not interested | `HIDE` | `feedbackEndpoint` | 140 chars |
| Don't recommend channel | `REMOVE` | `feedbackEndpoint` | 183 chars |
| Report | `FLAG` | `getReportFormEndpoint` | — |

## Where the action exists

| Surface | Offers "Don't recommend channel" |
| --- | --- |
| Home feed | Yes — 23/23 items |
| Watch sidebar | Yes — 20/20 items |
| Search results | No |
| Channel page | No |
| Under the watch-page video | No — menu is `[listItemViewModel, FLAG Report]` |

It appears only where YouTube is making a recommendation, which is coherent:
it is feedback on a recommendation, not a channel-level setting.

This is why the local blocklist is not optional. The place users most want the
button — under the video they are watching — is a place YouTube offers no
native action at all.

## Tokens are per-impression

Four videos from one channel in a single watch sidebar produced four distinct
`REMOVE` tokens. A second channel with two videos produced two distinct tokens.
Tokens are also server-encrypted: 183 base64 chars decode to 137 bytes of
high-entropy data with no plaintext channel or video id, matching the
`isFeedbackTokenUnencrypted: false` flag in the request.

So tokens cannot be derived, predicted or constructed. They can only be
harvested from an impression and spent later.

## Sending

```
POST https://www.youtube.com/youtubei/v1/feedback?key=<INNERTUBE_API_KEY>&prettyPrint=false

{
  "context": <ytcfg.data_.INNERTUBE_CONTEXT>,
  "isFeedbackTokenUnencrypted": false,
  "shouldMerge": false,
  "feedbackTokens": ["<token>"]
}
```

Headers: `Authorization: SAPISIDHASH …`, `X-Origin: https://www.youtube.com`,
`X-Goog-AuthUser: 0`, `Content-Type: application/json`, credentials included.

Read `context` and `apiKey` from `ytcfg.data_` at runtime. Do not hardcode the
client version — RegretsReporter still ships a 2021 value in its payload
builder, which is the failure this avoids.

A `200` is not sufficient. YouTube reports per-token results in
`feedbackResponses[].isProcessed`; check both.

## Auth computes in-page

The `SAPISID` cookie is not `HttpOnly`, and `crypto.subtle` is available, so:

```
Authorization: SAPISIDHASH <unix_seconds>_<sha1(unix_seconds SP SAPISID SP origin)>
```

can be built entirely from a content script. No `webRequest` permission, no
background header interception. This is a meaningful simplification over the
interception approach RegretsReporter uses.

## Verified end to end

A token harvested from a home-feed impression was fired 50 seconds later from an
unrelated watch page — a fresh page load that never rendered that impression.

- `HTTP 200`
- `feedbackResponses: [{ "isProcessed": true }]`
- the channel was absent from the next home-feed render

Cached tokens therefore work across page contexts, which is what makes a
watch-page button able to reach the algorithm at all.

## There is no undo

The response carries no undo token. YouTube's own Undo exists only in the
transient snackbar after a UI click, and per Mozilla's guidance it does not
fully reverse the algorithmic effect anyway. The only reversal paths are
subscribing to the channel or bulk-deleting activity via MyActivity, both of
which are far blunter than the original action.

Hence the deferred-fire design in `Src/core/dontRecommend.js`: block locally at
once, hold the request for an undo window, and only then spend the token.

## Still unknown

- **Token lifetime.** 50 seconds is proven; hours and days are not.
  `tokenCache.recordOutcome` logs age against success on every fire so the real
  curve emerges from usage. Read it with `__youfact.stats().expiry`.
- **Effect magnitude.** Mozilla measured "Don't recommend channel" as blocking
  roughly 43% of unwanted recommendations, versus about 11% for "Not
  interested". It is the strongest lever YouTube offers and still partial.

## Sources

- [mozilla-extensions/regrets-reporter](https://github.com/mozilla-extensions/regrets-reporter) — production implementation of the same endpoint
- [Reverse-Engineering YouTube: Revisited](https://tyrrrz.me/blog/reverse-engineering-youtube-revisited) — InnerTube auth conventions
- [Mozilla Foundation: RegretsReporter](https://www.mozillafoundation.org/en/youtube/regretsreporter/) — effectiveness study
