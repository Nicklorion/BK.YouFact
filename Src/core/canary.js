/**
 * Breakage detection.
 *
 * Everything this extension does to YouTube rests on undocumented structure
 * that changes without notice. The failure mode to avoid is not breaking — it
 * is breaking *silently* and finding out weeks later from a bug report.
 *
 * Each probe is a claim that was true when measured, tagged with the client
 * version it was measured against. When one fails we degrade deliberately
 * instead of pretending the action worked.
 */

import { KNOWN_ICONS } from '../youtube/schema.js';

/** The client these probes were last verified against. */
export const VERIFIED_CLIENT_VERSION = '2.20260805.01.00';

/**
 * @param {{clientConfig: object|null, items: Array<{channelId: string|null, token: string|null}>, icons: string[]}} sample
 */
export function runCanaries(sample) {
  const { clientConfig, items = [], icons = [] } = sample;
  const withToken = items.filter((item) => item.token);
  const withChannel = items.filter((item) => item.channelId);

  const probes = [
    {
      name: 'client-config',
      ok: Boolean(clientConfig?.apiKey && clientConfig?.clientVersion),
      detail: clientConfig?.clientVersion ?? 'ytcfg unreadable'
    },
    {
      name: 'signed-in',
      ok: Boolean(clientConfig?.loggedIn),
      detail: clientConfig?.loggedIn ? 'yes' : 'signed out — YouTube serves no feedback tokens'
    },
    {
      name: 'channel-ids',
      ok: withChannel.length > 0,
      detail: `${withChannel.length}/${items.length} items resolved a channel id`
    },
    {
      // Only meaningful on recommendation surfaces; search and channel pages
      // legitimately carry none.
      name: 'feedback-tokens',
      ok: items.length === 0 || withToken.length > 0,
      detail: `${withToken.length}/${items.length} items carried a REMOVE token`
    },
    {
      name: 'icon-enum',
      ok: icons.length === 0 || icons.some((icon) => KNOWN_ICONS.includes(icon)),
      detail: icons.length ? `saw ${icons.slice(0, 8).join(', ')}` : 'no icons observed'
    }
  ];

  return {
    clientVersion: clientConfig?.clientVersion ?? null,
    verifiedAgainst: VERIFIED_CLIENT_VERSION,
    clientDrifted: Boolean(
      clientConfig?.clientVersion && clientConfig.clientVersion !== VERIFIED_CLIENT_VERSION
    ),
    probes,
    healthy: probes.every((probe) => probe.ok)
  };
}
