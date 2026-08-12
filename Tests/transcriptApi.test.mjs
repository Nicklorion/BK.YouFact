import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTranscriptParams, fetchTranscript } from '../Src/youtube/transcriptApi.js';

/**
 * Captured from YouTube's own get_panel request on client 2.20260807.00.00.
 * If this vector ever stops matching, the params schema changed and the direct
 * route is broken, which is exactly what this test exists to catch.
 */
test('builds params byte-identical to YouTube for a known vector', () => {
  assert.equal(buildTranscriptParams('ZgHG2jJTiQ8'), 'qgkPCgtaZ0hHMmpKVGlROBgC');
});

test('params encode the video id and nothing else that varies', () => {
  const a = buildTranscriptParams('R_g9EeT233Q');
  const b = buildTranscriptParams('R_g9EeT233Q');
  assert.equal(a, b, 'construction must be deterministic');
  assert.notEqual(a, buildTranscriptParams('ZgHG2jJTiQ8'));

  // Video ids are always 11 chars, so the length prefix is stable.
  const decoded = Buffer.from(a, 'base64');
  assert.equal(decoded[0], 0xaa, 'field 149 tag');
  assert.equal(decoded[1], 0x09);
  assert.ok(decoded.includes(Buffer.from('R_g9EeT233Q')), 'video id must be embedded verbatim');
});

const clientConfig = {
  clientVersion: '2.20260807.00.00',
  context: { client: { clientName: 'WEB', visitorData: 'VISITOR' } }
};

function stubFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return response;
  };
  impl.calls = calls;
  return impl;
}

test('refuses only when there is no video id — that is the one required input', async () => {
  const result = await fetchTranscript({ videoId: '', clientConfig });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-video-id');
});

test('fires without a client config, because the endpoint does not need one', async () => {
  // Measured: a hand-built minimal context returns the same 198 segments as
  // the real ytcfg one. Refusing to try without ytcfg turned a working route
  // into a dead one whenever the harvester had not reported yet.
  const fetchImpl = stubFetch({ ok: true, status: 200, json: async () => ({ contents: [] }) });
  const result = await fetchTranscript({
    videoId: 'abcdefghijk',
    clientConfig: null,
    buildAuth: async () => 'SAPISIDHASH test',
    fetchImpl
  });

  assert.equal(result.reason, 'no-captions', 'reached the server rather than short-circuiting');
  const body = JSON.parse(fetchImpl.calls[0].init.body);
  assert.equal(body.context.client.clientName, 'WEB');
  assert.ok(body.context.client.clientVersion, 'substituted context must carry a version');
});

test('sends the request unsigned when there is no cookie to sign with', async () => {
  // buildAuthHeader throws for a signed-out user, or one whose browser
  // partitions Google's cookies. The endpoint answers unauthenticated, so that
  // throw must not take the request down with it.
  const fetchImpl = stubFetch({ ok: true, status: 200, json: async () => ({ contents: [] }) });
  const result = await fetchTranscript({
    videoId: 'abcdefghijk',
    clientConfig,
    buildAuth: async () => {
      throw new Error('not signed in to YouTube — no SAPISID cookie');
    },
    fetchImpl
  });

  assert.equal(result.reason, 'no-captions', 'must not be reported as a network failure');
  const { headers } = fetchImpl.calls[0].init;
  assert.equal(headers.authorization, undefined, 'no header beats a broken one');
  assert.equal(headers['x-goog-authuser'], undefined);
});

test('omits the visitor id header rather than sending it empty', async () => {
  const fetchImpl = stubFetch({ ok: true, status: 200, json: async () => ({ contents: [] }) });
  await fetchTranscript({
    videoId: 'abcdefghijk',
    clientConfig: { clientVersion: '2.20260807.00.00', context: { client: { clientName: 'WEB' } } },
    buildAuth: async () => 'SAPISIDHASH test',
    fetchImpl
  });

  assert.equal(fetchImpl.calls[0].init.headers['x-goog-visitor-id'], undefined);
});

test('treats a 200 with no segments as no-captions, not as an error', async () => {
  // This is the normal shape for a video that genuinely has none, and the UI
  // must be able to say so rather than reporting a failure.
  const result = await fetchTranscript({
    videoId: 'abcdefghijk',
    clientConfig,
    buildAuth: async () => 'SAPISIDHASH test',
    fetchImpl: stubFetch({ ok: true, status: 200, json: async () => ({ contents: [] }) })
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-captions');
  assert.equal(result.status, 200);
});

test('surfaces HTTP failures with their status', async () => {
  const result = await fetchTranscript({
    videoId: 'abcdefghijk',
    clientConfig,
    buildAuth: async () => 'SAPISIDHASH test',
    fetchImpl: stubFetch({ ok: false, status: 400, json: async () => ({}) })
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'http-error');
  assert.equal(result.status, 400);
});

test('parses segments out of a get_panel response', async () => {
  const payload = {
    contents: [
      {
        macroMarkersPanelItemViewModel: {
          item: {
            timelineItemViewModel: {
              timestamp: '0:04',
              contentItems: [{ transcriptSegmentViewModel: { simpleText: 'Hello there.' } }]
            }
          }
        }
      },
      {
        macroMarkersPanelItemViewModel: {
          item: {
            timelineItemViewModel: {
              timestamp: '0:09',
              contentItems: [{ transcriptSegmentViewModel: { simpleText: 'Second line.' } }]
            }
          }
        }
      }
    ]
  };

  const fetchImpl = stubFetch({ ok: true, status: 200, json: async () => payload });
  const result = await fetchTranscript({ videoId: 'abcdefghijk', clientConfig, fetchImpl, buildAuth: async () => 'SAPISIDHASH test' });

  assert.equal(result.ok, true);
  assert.equal(result.segments.length, 2);
  assert.equal(result.segments[0].startMs, 4000);
  assert.equal(result.segments[0].text, 'Hello there.');

  const { url, init } = fetchImpl.calls[0];
  assert.match(url, /youtubei\/v1\/get_panel\?prettyPrint=false$/);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'include');
  const body = JSON.parse(init.body);
  assert.equal(body.panelId, 'PAmodern_transcript_view');
  assert.equal(body.params, buildTranscriptParams('abcdefghijk'));
});

