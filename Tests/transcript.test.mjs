import test from 'node:test';
import assert from 'node:assert/strict';

import { segmentsFromPayload, parseTimestamp, toPassages } from '../Src/youtube/transcript.js';

/** Shape measured live on client 2.20260805.01.00 — the modern transcript panel. */
const modernPayload = {
  contents: [
    {
      itemSectionRenderer: {
        contents: [
          {
            macroMarkersPanelItemViewModel: {
              item: {
                timelineItemViewModel: {
                  timestamp: '0:06',
                  contentItems: [{ transcriptSegmentViewModel: { simpleText: 'First line spoken.' } }]
                }
              }
            }
          },
          {
            macroMarkersPanelItemViewModel: {
              item: {
                timelineItemViewModel: {
                  timestamp: '0:13',
                  contentItems: [{ transcriptSegmentViewModel: { simpleText: 'Second line spoken.' } }]
                }
              }
            }
          }
        ]
      }
    }
  ]
};

/** The pre-migration shape, still worth supporting until it is gone everywhere. */
const legacyPayload = [
  { transcriptSegmentRenderer: { startMs: '0', endMs: '4000', snippet: { runs: [{ text: 'Legacy line.' }] } } }
];

test('parses timestamps at both minute and hour resolution', () => {
  assert.equal(parseTimestamp('0:06'), 6000);
  assert.equal(parseTimestamp('4:07'), 247000);
  assert.equal(parseTimestamp('1:02:03'), 3723000);
  assert.equal(parseTimestamp('nonsense'), null);
  assert.equal(parseTimestamp(undefined), null);
});

test('reads the modern timelineItemViewModel schema', () => {
  const segments = segmentsFromPayload(modernPayload);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].startMs, 6000);
  assert.equal(segments[0].text, 'First line spoken.');
  // The modern schema carries no end bound; it is inferred from the next start.
  assert.equal(segments[0].endMs, 13000);
});

test('still reads the legacy transcriptSegmentRenderer schema', () => {
  const segments = segmentsFromPayload(legacyPayload);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].startMs, 0);
  assert.equal(segments[0].endMs, 4000);
});

test('never produces a zero-length span when timestamps collide', () => {
  // Display timestamps only have second resolution, so neighbours can share one.
  const collided = {
    a: { timelineItemViewModel: { timestamp: '0:10', contentItems: [{ transcriptSegmentViewModel: { simpleText: 'one' } }] } },
    b: { timelineItemViewModel: { timestamp: '0:10', contentItems: [{ transcriptSegmentViewModel: { simpleText: 'two' } }] } }
  };
  const segments = segmentsFromPayload(collided);
  assert.equal(segments.length, 2);
  for (const segment of segments) {
    assert.ok(segment.endMs > segment.startMs, `span must be positive, got ${segment.startMs}..${segment.endMs}`);
  }
});

test('groups fragments into passages a model can reason over', () => {
  const segments = Array.from({ length: 30 }, (_, index) => ({
    startMs: index * 2000,
    endMs: (index + 1) * 2000,
    text: `fragment ${index}`
  }));

  const passages = toPassages(segments, { targetSeconds: 45 });
  assert.ok(passages.length > 1 && passages.length < segments.length, 'should collapse, not passthrough');
  assert.equal(passages[0].startMs, 0);
  assert.ok(passages[0].text.includes('fragment 0'));
  assert.match(passages[0].timestamp, /^\d+:\d{2}$/);
  // Passages must stay in order so a claim's timestamp still means something.
  assert.deepEqual(
    passages.map((passage) => passage.startMs),
    [...passages.map((passage) => passage.startMs)].sort((a, b) => a - b)
  );
});
