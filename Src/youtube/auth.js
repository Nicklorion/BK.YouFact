/**
 * InnerTube request signing.
 *
 * Authenticated InnerTube endpoints reject cookies alone — they want a
 * SAPISIDHASH header, which is Google's anti-CSRF scheme:
 *
 *   Authorization: SAPISIDHASH <unix_seconds>_<sha1(unix_seconds SP SAPISID SP origin)>
 *
 * The SAPISID cookie is not HttpOnly, so this computes in-page from a content
 * script. That is why the extension needs no `webRequest` permission and no
 * background header interception.
 */

export const ORIGIN = 'https://www.youtube.com';

/** Cookie names in preference order; the plain one is what youtube.com uses. */
const COOKIE_CANDIDATES = ['SAPISID', '__Secure-3PAPISID', '__Secure-1PAPISID'];

export function readAuthCookie(cookieString = document.cookie) {
  const jar = cookieString.split('; ');
  for (const name of COOKIE_CANDIDATES) {
    const prefix = `${name}=`;
    const hit = jar.find((entry) => entry.startsWith(prefix));
    if (hit) return hit.slice(prefix.length);
  }
  return null;
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * @throws if the user is not signed in to YouTube — there is no cookie to sign with.
 */
export async function buildAuthHeader({ now = Date.now(), origin = ORIGIN, cookieString } = {}) {
  const sapisid = readAuthCookie(cookieString ?? document.cookie);
  if (!sapisid) throw new Error('not signed in to YouTube — no SAPISID cookie');

  const seconds = Math.floor(now / 1000);
  const payload = new TextEncoder().encode(`${seconds} ${sapisid} ${origin}`);
  const digest = await crypto.subtle.digest('SHA-1', payload);

  return `SAPISIDHASH ${seconds}_${toHex(digest)}`;
}
