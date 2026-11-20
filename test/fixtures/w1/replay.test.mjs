// Harness tests only. No assertions here establish W1 product acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replay } from './replay.mjs';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
test('captures typed fields, discards ACK, and resends the same payload', async () => {
  const calls = [], transcript = [];
  const scenario = { steps: [
    { name: 'claim', path: '/claim', status: 200, capture: { work: 'work' } },
    { name: 'lost ack', method: 'POST', path: '/intent', body: { version: '${work.version}' }, status: 200, discard_response: true },
    { name: 'retry', method: 'POST', path: '/intent', body: { version: '${work.version}' }, status: 200, equals: { result: 'ok' } },
  ] };
  const bodies = [{ work: { version: 3 } }, { result: 'ok' }, { result: 'ok' }];
  await replay(scenario, { baseUrl: 'http://localhost', token: 'secret', fetchImpl: async (url, init) => { calls.push(init); return response(bodies.shift()); }, record: entry => transcript.push(entry) });
  assert.equal(calls[1].body, calls[2].body);
  assert.deepEqual(JSON.parse(calls[1].body), { version: 3 });
  assert.doesNotMatch(JSON.stringify(transcript), /secret|version/);
});
test('fails on wrong response, missing variables and external path', async () => {
  const options = { baseUrl: 'http://localhost', token: 'secret', fetchImpl: async () => response({}, 403) };
  await assert.rejects(replay({ steps: [{ name: 'x', path: '/', status: 200 }] }, options), /HTTP status/);
  await assert.rejects(replay({ steps: [{ name: 'x', path: '/${missing}', status: 200 }] }, options), /missing variable/);
  await assert.rejects(replay({ steps: [{ name: 'x', path: '//evil.test', status: 200 }] }, options), /relative target/);
});
test('validates delays and delegates waiting to injected clock', async () => {
  const sleeps = [];
  await replay({ steps: [{ name: 'wait', sleep_ms: '${delay}' }] }, { baseUrl: 'http://localhost', token: 'x', variables: { delay: 23 }, sleep: async ms => sleeps.push(ms) });
  assert.deepEqual(sleeps, [23]);
  await assert.rejects(replay({ steps: [{ sleep_ms: -1 }] }, { baseUrl: 'http://localhost', token: 'x' }), /invalid delay/);
});

test('fault proxy injects 429 and disconnect without recording credentials', async () => {
  const { createFaultProxy } = await import('./fault-proxy.mjs');
  const entries = [];
  const proxy = createFaultProxy({ upstream: 'http://127.0.0.1:8787', mode: 'rate-limit', failures: 1, retryAfter: 4, log: e => entries.push(e) });
  const request = { headers: { authorization: 'secret' } };
  const output = {};
  proxy.emit('request', request, { writeHead: (status, headers) => Object.assign(output, { status, headers }), end: () => {} });
  assert.equal(output.status, 429);
  assert.equal(output.headers['retry-after'], '4');
  assert.doesNotMatch(JSON.stringify(entries), /secret/);
  let destroyed = false;
  const disconnect = createFaultProxy({ upstream: 'http://127.0.0.1:8787', mode: 'disconnect', failures: 1 });
  disconnect.emit('request', { socket: { destroy: () => { destroyed = true; } } }, {});
  assert.equal(destroyed, true);
});
