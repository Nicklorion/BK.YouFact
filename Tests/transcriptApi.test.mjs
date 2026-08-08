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

test('reports missing configuration rather than firing a doomed request', async () => {
  const result = await fetchTranscript({ videoId: 'abcdefghijk', clientConfig: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-client-config');
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

