# Changelog

## 1.0.0-rc.1

First release candidate. The fact-check pipeline runs end to end.

Chrome's manifest `version` field takes integers only, so it reads `1.0.0`
there; `version_name` carries the `-rc.1`.

### Fact-checking now works

Three faults, each of which alone was enough to stop a check completing.

- **Transcripts were gated on things the endpoint does not need.** `get_panel`
  was measured four ways against client `2.20260811.01.00` — with full `ytcfg`
  and a signed request, with no cookies, with a hand-built minimal context, and
  with a year-stale client version. All four returned the same 198 segments. It
  needs the video id and nothing else. Previously a missing `ytcfg` short
  circuited the request, and `buildAuthHeader` throwing for a signed-out user
  (or a browser partitioning Google's cookies) was caught and reported as a
  network failure. Both are now best effort.
- **`budget_tokens` is a 400 on the default model.** Extended thinking was
  removed on Opus 5, Sonnet 5 and Fable 5; the research stage could never have
  run. Now adaptive thinking plus `output_config.effort`, with the legacy budget
  kept only for Haiku 4.5, which still takes it and rejects `effort`.
- **Paused turns were discarded.** Server-side web search runs its own sampling
  loop; when it hits the iteration cap the turn returns `pause_turn` with the
  searches done but no findings written. That was being read as a finished turn,
  so every claim came back unverified with no sources. Paused turns are now
  resumed by echoing the assistant turn back, accumulating content and usage.

### Research actually researches

- **One request per claim**, each with its own search budget, four in flight.
  Previously every claim shared a single call with a six-search budget — most
  claims could not be looked up even in principle.
- **Sources are harvested from search results as well as citations.** Citations
  only cover what the model chose to lean on; a turn whose prose came back
  unannotated was reporting zero sources despite a working search.
- **Search errors are recorded** rather than being indistinguishable from
  "nothing found". On failure that block carries an error object where the
  result list goes, which the old code would also have thrown on.
- **The judge gets per-claim dossiers** — that claim's research and that claim's
  citable URLs — instead of one undifferentiated blob.
- New **research depth** setting: Quick (2 searches per claim) through
  Exhaustive (15), separate from effort, which buys reasoning rather than
  lookups. The options page states the resulting ceiling per video.

### The button

- The score is now a **gauge**: an arc filled in proportion to the score, with a
  red → amber → green gradient running along it, so fill position and hue say
  the same thing. The numeral sits in the cup, larger than the plain number it
  replaced; three-digit scores take a smaller face because 100 would otherwise
  sit on the arc.
- The same gauge appears in the panel header at twice the size.
- **The badge was `disabled` whenever a score existed**, so the score half of
  the pill was never clickable. Fixed.
- "Checked" became "Details" — it says what the button does rather than
  restating what the gauge shows.
- **The pill and panel no longer contradict each other.** The pill read
  `9 claims` beside a panel headed `12 claims`. Both were right — accuracy
  excludes unverified claims — but the label was wrong. Now `9 of 12 judged`,
  and the panel breakdown includes `supported` so it visibly sums to the total.

### Not restarting itself, and saying why it stopped

- **The action button is disabled while a check runs.** Every impatient second
  click was abandoning the run in flight and paying for a new one.
- **The service worker is kept alive by a heartbeat** every 20 seconds. It is
  torn down after ~30s of inactivity and a pending `fetch` does not reset that
  timer, so long research stages were killing it mid-check — surfacing as
  `Disconnected` with no indication of where it died.
- `loadSettings` sat outside the try block: when it threw, the rejection was
  swallowed and the check hung until the worker died.
- Failures now name the **stage** and **elapsed time**, put the provider's own
  message in the tooltip and the console, and keep it on
  `__youfact.lastFailure`. A `stop_reason: "refusal"` is reported as a declined
  request rather than as "no checkable claims found".
- A check in flight no longer paints its progress onto the pill of a video you
  navigated to.
- The running label carries progress and a clock: `Researching claims · 5/12 · 47s`.

### Tests

33 → 67. New suites for the provider request shapes (including regressions for
the `budget_tokens` 400, `pause_turn` resume and unannotated-source harvesting),
the worker's terminal-message and heartbeat contract, and the pill/panel count
reconciliation.
