import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The check pipeline as the content script sees it: a port, a stream of stage
 * messages, and exactly one terminal message.
 *
 * The bug these exist for is "! Disconnected" — a check that neither finished
 * nor reported a failure, because the worker was collected mid-run and nothing
 * had been posted since the stage began.
 */

// worker.js touches chrome.runtime at import time, and storage.js decides
// between chrome.storage and its in-memory fallback the same way, so both have
// to see this before either is loaded.
globalThis.chrome = {
  runtime: { onConnect: { addListener() {} }, onInstalled: { addListener() {} } }
};

const { runCheck, STAGE } = await import('../Src/background/worker.js');
const { write } = await import('../Src/core/storage.js');

function fakePort({ throwOnPost = false } = {}) {
  const sent = [];
  return {
    sent,
    onDisconnect: { addListener() {} },
    postMessage(message) {
      if (throwOnPost) throw new Error('Attempting to use a disconnected port object');
      sent.push(message);
    },
    terminal: () => sent.find((m) => m.stage === STAGE.DONE || m.stage === STAGE.FAILED) ?? null
  };
}

const payload = {
  videoId: 'abcdefghijk',
  channelId: 'UC00000000000000000000',
  metadata: { title: 'T', author: 'A' },
  passages: [{ startMs: 0, timestamp: '0:00', text: 'A claim.' }]
};

const configure = () => write('settings', { apiKey: 'sk-ant-test', model: 'claude-opus-5' });

test('an unconfigured key reports itself instead of hanging', async () => {
  await write('settings', { apiKey: '' });
  const port = fakePort();
  await runCheck(port, payload);

  assert.equal(port.terminal()?.stage, STAGE.FAILED);
  assert.equal(port.terminal()?.reason, 'not-configured');
});

test('always reaches a terminal message — the symptom was reaching none', async () => {
  await configure();
  const port = fakePort();
  await runCheck(port, { ...payload, passages: [] });

  assert.equal(port.terminal()?.reason, 'no-transcript');
});

test('beats while a stage is thinking, so the worker is not collected mid-check', async () => {
  await configure();
  // A stage that takes long enough for several beats at a test-sized interval.
  globalThis.fetch = async () =>
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            ok: true,
            status: 200,
            json: async () => ({
              content: [{ type: 'tool_use', name: 'record_claims', input: { claims: [] } }],
              usage: {}
            })
          }),
        60
      )
    );

  const port = fakePort();
  await runCheck(port, payload, { heartbeatMs: 10 });

  const beats = port.sent.filter((m) => m.heartbeat);
  assert.ok(beats.length >= 2, `expected repeated heartbeats, saw ${beats.length}`);
  assert.equal(beats[0].stage, STAGE.EXTRACT, 'a beat must name the stage it is beating for');
  assert.ok(beats.at(-1).elapsedMs >= beats[0].elapsedMs, 'beats carry a running clock');
});

test('stops beating once the check is over', async () => {
  await configure();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'record_claims', input: { claims: [] } }],
      usage: {}
    })
  });

  const port = fakePort();
  await runCheck(port, payload, { heartbeatMs: 5 });
  const afterFinish = port.sent.length;

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(port.sent.length, afterFinish, 'a finished check must not keep the worker awake');
});

test('names the stage a provider error happened in', async () => {
  await configure();
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => ({ error: { message: 'thinking.budget_tokens: unexpected field' } })
  });

  const port = fakePort();
  await runCheck(port, payload);

  const terminal = port.terminal();
  assert.equal(terminal.reason, 'provider-error');
  assert.equal(terminal.failedStage, STAGE.EXTRACT, 'a bare "provider error" is not actionable');
  assert.match(terminal.message, /budget_tokens/);
  assert.equal(typeof terminal.elapsedMs, 'number');
});

test('a port that has gone away does not take the worker down with it', async () => {
  await configure();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ content: [], usage: {} })
  });

  // Every postMessage throws, including the one reporting the failure.
  await assert.doesNotReject(() => runCheck(fakePort({ throwOnPost: true }), payload));
});
