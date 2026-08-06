/**
 * Resolvers for YouTube's menu feedback tokens.
 *
 * YouTube ships two rendering architectures side by side and expresses the same
 * menu differently in each. Everything here resolves by *shape* — never by a
 * fixed path and never by visible label. Paths change with every layout
 * revision; labels are localised into 80+ languages.
 *
 * Legacy (ytd-video-renderer — search results):
 *   menuServiceItemRenderer
 *     .icon.iconType                                     -> icon enum
 *     .serviceEndpoint.feedbackEndpoint.feedbackToken     -> token
 *
 * Modern (lockupViewModel — home feed, watch sidebar):
 *   listItemViewModel
 *     .leadingImage.sources[0].clientResource.imageName   -> icon enum
 *     .rendererContext.commandContext.onTap.innertubeCommand
 *       .feedbackEndpoint.feedbackToken                   -> token
 *
 * Measured against client 2.20260805.01.00. See Docs/dont-recommend.md.
 */

/** Stable across both architectures. */
export const ICON_DONT_RECOMMEND_CHANNEL = 'REMOVE';

/** Diverged between architectures: HIDE is modern, NOT_INTERESTED is legacy. */
export const ICONS_NOT_INTERESTED = Object.freeze(['HIDE', 'NOT_INTERESTED']);

/**
 * Icon names we expect to keep seeing. A menu that yields none of these is the
 * signal that YouTube renamed the enum — see canary.js.
 */
export const KNOWN_ICONS = Object.freeze([
  'ADD_TO_QUEUE_TAIL',
  'WATCH_LATER',
  'BOOKMARK_BORDER',
  'SHARE',
  'HIDE',
  'NOT_INTERESTED',
  'REMOVE',
  'FLAG'
]);

const MAX_DEPTH = 45;

/**
 * Depth-first visit of every plain object reachable from `root`.
 * Cycle-safe and depth-bounded — YouTube payloads self-reference freely.
 */
function visit(root, onObject) {
  const seen = new WeakSet();

  (function walk(node, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_DEPTH || seen.has(node)) return;
    seen.add(node);
    if (!Array.isArray(node)) onObject(node);
    for (const key in node) walk(node[key], depth + 1);
  })(root, 0);
}

/**
 * Every feedback token reachable from `root`, in both schemas.
 * Accepts an element's bound payload, ytInitialData, or an InnerTube response body.
 *
 * @returns {Array<{icon: string|null, label: string|null, token: string}>}
 */
export function findFeedbackTokens(root) {
  const found = [];

  visit(root, (node) => {
    const modern = node.listItemViewModel;
    if (modern) {
      const token =
        modern.rendererContext?.commandContext?.onTap?.innertubeCommand
          ?.feedbackEndpoint?.feedbackToken;
      if (token) {
        found.push({
          icon: modern.leadingImage?.sources?.[0]?.clientResource?.imageName ?? null,
          label: modern.title?.content ?? null,
          token
        });
      }
    }

    const legacy = node.menuServiceItemRenderer;
    if (legacy) {
      const token = legacy.serviceEndpoint?.feedbackEndpoint?.feedbackToken;
      if (token) {
        found.push({
          icon: legacy.icon?.iconType ?? null,
          label: legacy.text?.simpleText ?? legacy.text?.runs?.[0]?.text ?? null,
          token
        });
      }
    }
  });

  return found;
}

/** The "Don't recommend channel" token, or null if this payload doesn't carry one. */
export function findDontRecommendToken(root) {
  const hit = findFeedbackTokens(root).find((e) => e.icon === ICON_DONT_RECOMMEND_CHANNEL);
  return hit ? hit.token : null;
}

const CHANNEL_ID = /^UC[\w-]{22}$/;

/**
 * The channel a payload belongs to. Channel ids surface as `browseId` on
 * navigation endpoints, which has held across both architectures.
 */
export function findChannelId(root) {
  let id = null;
  visit(root, (node) => {
    if (id) return;
    if (typeof node.browseId === 'string' && CHANNEL_ID.test(node.browseId)) id = node.browseId;
  });
  return id;
}

const VIDEO_ID = /^[\w-]{11}$/;

/** The video a payload belongs to. `contentId` is modern, `videoId` legacy. */
export function findVideoId(root) {
  if (typeof root?.contentId === 'string' && VIDEO_ID.test(root.contentId)) return root.contentId;
  if (typeof root?.videoId === 'string' && VIDEO_ID.test(root.videoId)) return root.videoId;

  let id = null;
  visit(root, (node) => {
    if (id) return;
    for (const key of ['contentId', 'videoId']) {
      if (typeof node[key] === 'string' && VIDEO_ID.test(node[key])) {
        id = node[key];
        return;
      }
    }
  });
  return id;
}

/**
 * The channel's display name, for labelling controls and the blocklist.
 *
 * Resolved by finding text that links to a channel rather than by reaching for
 * a known field — the byline lives at a different path in every renderer
 * (`longBylineText`, `ownerText`, `contentMetadataViewModel`, `title`), but in
 * all of them the visible name sits next to a browse endpoint for the channel.
 */
export function findChannelName(root) {
  let name = null;

  visit(root, (node) => {
    if (name) return;

    // Legacy runs: { text: 'Name', navigationEndpoint: { browseEndpoint: { browseId } } }
    if (
      typeof node.text === 'string' &&
      CHANNEL_ID.test(node.navigationEndpoint?.browseEndpoint?.browseId ?? '')
    ) {
      name = node.text;
      return;
    }

    // Modern parts: { text: { content: 'Name', commandRuns: [{ onTap: { innertubeCommand } }] } }
    const content = node.text?.content;
    if (typeof content === 'string' && Array.isArray(node.text?.commandRuns)) {
      const linksToChannel = node.text.commandRuns.some((run) =>
        CHANNEL_ID.test(run.onTap?.innertubeCommand?.browseEndpoint?.browseId ?? '')
      );
      if (linksToChannel) name = content;
    }
  });

  return name;
}

/**
 * Everything worth extracting from one rendered item.
 * `token` is null on surfaces that don't offer the action — search results and
 * channel pages never do, only recommendation surfaces.
 */
export function describeItem(payload) {
  return {
    channelId: findChannelId(payload),
    channelName: findChannelName(payload),
    videoId: findVideoId(payload),
    token: findDontRecommendToken(payload)
  };
}
