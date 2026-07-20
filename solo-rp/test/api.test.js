/**
 * API client tests.
 *
 * The point of interest is the SSE parser: chunk boundaries that fall in the
 * middle of a line, keep-alive comments, the [DONE] sentinel, and error bodies.
 * A stubbed fetch returns a ReadableStream we control, so the exact token stream
 * can be scripted. Nothing hits the network.
 *
 *   node test/api.test.js
 */

import assert from 'node:assert/strict';
import { streamChat, complete, readError, DEFAULT_ENDPOINT } from '../src/api.js';

let passed = 0;
const failures = [];
async function it(name, fn) {
  try { await fn(); passed += 1; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  \x1b[31m✗\x1b[0m ${name}`); console.log(`    \x1b[31m${err.message.split('\n')[0]}\x1b[0m`); }
}

const enc = new TextEncoder();
const settings = { apiKey: 'k', model: 'test/model' };

/** A fetch that streams the given raw string, optionally split into fixed-size pieces. */
function streamingFetch(raw, { chunkSize = 999999, status = 200, captureInto } = {}) {
  return async (url, opts) => {
    if (captureInto) { captureInto.url = url; captureInto.opts = opts; }
    if (status !== 200) {
      return new Response(raw, { status, headers: { 'content-type': 'application/json' } });
    }
    const bytes = enc.encode(raw);
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
}

const sse = (deltas) =>
  deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`).join('') + 'data: [DONE]\n\n';

async function collect(gen) {
  const out = [];
  for await (const c of gen) out.push(c);
  return out;
}

console.log('\napi client\n');

await it('yields each delta in order', async () => {
  const fetchImpl = streamingFetch(sse(['Hel', 'lo, ', 'world']));
  const chunks = await collect(streamChat({ messages: [], settings, fetchImpl }));
  assert.deepEqual(chunks, ['Hel', 'lo, ', 'world']);
});

await it('reassembles deltas split across network chunks', async () => {
  // 7-byte chunks slice right through the JSON lines.
  const fetchImpl = streamingFetch(sse(['alpha', 'beta', 'gamma']), { chunkSize: 7 });
  const full = (await collect(streamChat({ messages: [], settings, fetchImpl }))).join('');
  assert.equal(full, 'alphabetagamma');
});

await it('ignores keep-alive comment lines', async () => {
  const raw = ': OPENROUTER PROCESSING\n\n' + sse(['ok']);
  const fetchImpl = streamingFetch(raw);
  assert.deepEqual(await collect(streamChat({ messages: [], settings, fetchImpl })), ['ok']);
});

await it('stops at [DONE] and ignores anything after it', async () => {
  const raw = sse(['done']) + 'data: {"choices":[{"delta":{"content":"AFTER"}}]}\n\n';
  const fetchImpl = streamingFetch(raw);
  assert.deepEqual(await collect(streamChat({ messages: [], settings, fetchImpl })), ['done']);
});

await it('non-streaming mode returns the whole message', async () => {
  const body = JSON.stringify({ choices: [{ message: { content: 'a full reply' } }] });
  const fetchImpl = streamingFetch(body);
  const chunks = await collect(streamChat({ messages: [], settings: { ...settings, stream: false }, fetchImpl }));
  assert.deepEqual(chunks, ['a full reply']);
});

await it('throws a readable error on a non-OK response', async () => {
  const fetchImpl = streamingFetch(JSON.stringify({ error: { message: 'insufficient credits' } }), { status: 402 });
  await assert.rejects(collect(streamChat({ messages: [], settings, fetchImpl })), /402.*insufficient credits/);
});

await it('refuses to call out with no API key', async () => {
  await assert.rejects(collect(streamChat({ messages: [], settings: { model: 'm' } })), /No API key/);
});

await it('sends the key, the model and the default endpoint', async () => {
  const cap = {};
  const fetchImpl = streamingFetch(sse(['x']), { captureInto: cap });
  await collect(streamChat({ messages: [{ role: 'user', content: 'hi' }], settings, fetchImpl }));
  assert.equal(cap.url, DEFAULT_ENDPOINT);
  assert.equal(cap.opts.headers.Authorization, 'Bearer k');
  const sent = JSON.parse(cap.opts.body);
  assert.equal(sent.model, 'test/model');
  assert.equal(sent.stream, true);
  assert.deepEqual(sent.messages, [{ role: 'user', content: 'hi' }]);
});

await it('complete() concatenates and reports progress', async () => {
  const fetchImpl = streamingFetch(sse(['one ', 'two ', 'three']));
  const seen = [];
  const full = await complete({ messages: [], settings, fetchImpl, onToken: (_c, sofar) => seen.push(sofar) });
  assert.equal(full, 'one two three');
  assert.equal(seen.at(-1), 'one two three');
  assert.equal(seen.length, 3);
});

await it('readError degrades gracefully on non-JSON bodies', () => {
  assert.match(readError(500, '<html>Bad Gateway</html>'), /500/);
});

console.log(`\n${'─'.repeat(60)}`);
if (failures.length) {
  console.log(`\x1b[31m${failures.length} failed\x1b[0m, ${passed} passed\n`);
  for (const f of failures) console.log(`\x1b[31m✗ ${f.name}\x1b[0m\n${f.err.stack}\n`);
  process.exit(1);
}
console.log(`\x1b[32m${passed} passed\x1b[0m\n`);
process.exit(0);
