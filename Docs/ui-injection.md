# UI injection — measured anchors and gotchas

Measured against a live signed-in session, YouTube web client `2.20260805.01.00`.
Anchors are the most perishable thing in the extension; re-measure when the
canaries report client drift.

## Anchors

| Surface | Channel source | Insertion point | Placement |
| --- | --- | --- | --- |
| Watch page | `ytd-video-owner-renderer` `.data` | `ytd-watch-metadata #top-level-buttons-computed` | append, in flow |
| Feed / grid / sidebar | `yt-lockup-view-model` `rawProps.data()` | `yt-lockup-metadata-view-model` | absolute overlay |
| Legacy items | `ytd-video-renderer` `.data` | before `ytd-menu-renderer` | in flow |
| Shorts | `ytd-reel-video-renderer` `.data` | `reel-action-bar-view-model` | prepend |

Native control metrics worth matching:

- Watch action bar buttons: 40px tall, 20px radius, 14px text
- Shorts rail buttons: 48px, 24px radius

## Renderers nest — take the innermost

On the home feed every card is both a `ytd-rich-item-renderer` and, inside it, a
`yt-lockup-view-model`. Stamping both is correct for hiding (either match works)
but injecting into both produces two buttons per card.

Measured on a live feed: 42 elements stamped, 21 of each type. Filtering to
elements that contain no other stamped element yields exactly 21 mounts, all
lockups.

## The metadata row will squash and bury a naive mount

`yt-lockup-metadata-view-model` is `display: flex; position: relative`. Its
children are the avatar, the text container, and a `position: absolute` holder
carrying the native ⋮.

Appending a button to it as an ordinary flex child fails twice over, and both
failures are invisible in a screenshot:

- flex shrinks it from 32px to 24px wide
- the absolutely positioned ⋮ holder paints on top, so `elementFromPoint` at the
  button's centre returns YouTube's element and the button cannot be clicked

The fix is to mount absolutely and offset from the holder. The holder is found
structurally — the absolutely positioned child containing a button — rather than
by its class name, which is generated and will change.

Offsets are expressed as `right`, not `left`. The holder is right-anchored, so
its distance from the container's right edge is constant while its distance from
the left edge moves with width. Verified: forcing a layout change to 900px
without remounting leaves the gap at 2px, still vertically centred, still
clickable.

## YouTube enforces Trusted Types

Assigning `innerHTML` throws:

```
TypeError: Failed to set the 'innerHTML' property on 'Element':
This document requires 'TrustedHTML' assignment.
```

Build nodes with `createElement` / `createElementNS` / `append` instead. This
bites hardest for inline SVG icons, which are the obvious thing to reach for
`innerHTML` with.

## Theme

`--yt-spec-*` custom properties are not exposed on `:root`, so they cannot be
read from injected CSS. `html[dark]` is present and is what the stylesheet keys
off instead. Both themes are defined explicitly rather than inherited.

## Hiding is done with CSS, not DOM walking

Enforcement writes one stylesheet of
`[data-youfact-hideable][data-youfact-channel="UC…"] { display: none }` rules.
Because the rule matches an attribute rather than a node, infinite scroll, SPA
navigation and renderer recycling are all covered without any additional
bookkeeping.

Only elements carrying `data-youfact-hideable` are affected. The watch page
owner and the currently playing Short are stamped with a channel but deliberately
not marked hideable — blocking a channel must never blank the video being watched.

## Renderer recycling

YouTube reuses renderer elements: a card that displayed channel A can be
repopulated with channel B without being recreated. An already-present button is
therefore only valid while its `data-youfact-for` matches the current channel;
otherwise it is removed and replaced.
