import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from './server.mjs';
import { callAnthropic, validateChatRequest } from '../../../api/_lib/anthropic.mjs';

async function serve(t, options) {
  const server = createPreviewServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

function anthropicResponse(overrides = {}) {
  return new Response(JSON.stringify({
    model: 'claude-sonnet-5',
    content: [{ type: 'text', text: 'Enjoy your coffee.' }],
    usage: { input_tokens: 9, output_tokens: 5 },
    ...overrides,
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function postChat(base, body, headers = { 'content-type': 'application/json' }) {
  return fetch(`${base}/api/chat`, { method: 'POST', headers, body });
}

test('the preview serves a complete English application without external assets', async (t) => {
  const base = await serve(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /lang="en"/);
  assert.match(html, /Coffeenator/);
  assert.doesNotMatch(html, /https?:\/\//);
  for (const asset of ['/app.mjs', '/state.mjs', '/art.mjs', '/styles.css', '/tokens.css', '/favicon.svg', '/icons/gmail.png', '/icons/calendar.png', '/icons/drive.png', '/icons/github.svg', '/icons/supabase.svg', '/icons/claude.svg', '/icons/chatgpt.svg', '/icons/composio-black.svg', '/icons/composio-white.svg']) {
    const result = await fetch(base + asset);
    assert.equal(result.status, 200, asset);
    assert.ok(Number(result.headers.get('content-length')) > 0, asset);
  }
});

test('only preview assets are exposed, never source tests or repository files', async (t) => {
  const base = await serve(t);
  for (const path of ['/.env', '/server.mjs', '/state.test.mjs', '/AGENTS.md', '/PROJECT_CONTEXT.md', '/%2e%2e/.git/config']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
});

test('POST is only accepted on the chat endpoint, never for asset paths', async (t) => {
  const base = await serve(t);
  const response = await fetch(base, { method: 'POST', body: 'fictional test content' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET, HEAD');
  assert.match(response.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
});

test('HEAD responses include asset metadata without response bodies', async (t) => {
  const base = await serve(t);
  const response = await fetch(base + '/styles.css', { method: 'HEAD' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/css/);
  assert.ok(Number(response.headers.get('content-length')) > 0);
  assert.equal(await response.text(), '');
});

test('chat request validation enforces the shared endpoint contract', () => {
  assert.deepEqual(validateChatRequest({ messages: [{ role: 'user', content: 'Hello' }] }), { ok: true, errors: [] });
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }, { role: 'user', content: 'Thanks' }], system: 'Be brief.' }).ok, true);
  const rejected = [
    undefined,
    null,
    'plain text',
    [{ role: 'user', content: 'Hi' }],
    {},
    { messages: [] },
    { messages: [{ role: 'user', content: 'Hi' }], extra: true },
    { messages: [{ role: 'system', content: 'Hi' }] },
    { messages: [{ role: 'assistant', content: 'Hi' }] },
    { messages: [{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Hello.' }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 42 }] },
    { messages: [{ role: 'user', content: 'Hi', tool: 'x' }] },
    { messages: Array.from({ length: 41 }, () => ({ role: 'user', content: 'Hi' })) },
    { messages: [{ role: 'user', content: 'x'.repeat(65537) }] },
    { messages: [{ role: 'user', content: 'Hi' }], system: 42 },
    { messages: [{ role: 'user', content: 'Hi' }], system: 'x'.repeat(8193) },
  ];
  for (const [index, body] of rejected.entries()) {
    const result = validateChatRequest(body);
    assert.equal(result.ok, false, `rejected[${index}]`);
    assert.ok(result.errors.length > 0, `rejected[${index}]`);
  }
});

test('callAnthropic sends the documented request and concatenates text blocks', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return anthropicResponse({ content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'x' }, { type: 'text', text: ' there.' }], usage: { input_tokens: 12, output_tokens: 34 } });
  };
  const result = await callAnthropic({ messages: [{ role: 'user', content: 'Hi' }], system: 'Short.' }, { ANTHROPIC_API_KEY: 'unit-test-key' }, fetchImpl);
  assert.deepEqual(result, { reply: 'Hello there.', model: 'claude-sonnet-5', usage: { input_tokens: 12, output_tokens: 34 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-api-key'], 'unit-test-key');
  assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent, { model: 'claude-sonnet-5', max_tokens: 1024, messages: [{ role: 'user', content: 'Hi' }], system: 'Short.' });
});

test('callAnthropic reports upstream failures without leaking upstream details', async () => {
  const fetchImpl = async () => new Response('fictional secret upstream body', { status: 500 });
  await assert.rejects(
    callAnthropic({ messages: [{ role: 'user', content: 'Hi' }] }, { ANTHROPIC_API_KEY: 'unit-test-key' }, fetchImpl),
    (error) => !String(error.message).includes('fictional secret') && !String(error.message).includes('unit-test-key'),
  );
});

test('POST /api/chat rejects invalid bodies with the shared error envelope', async (t) => {
  const base = await serve(t, { env: {} });
  for (const body of [JSON.stringify({ messages: [] }), 'not json at all']) {
    const response = await postChat(base, body);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.schema_version, 1);
    assert.match(payload.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'VALIDATION_ERROR');
    assert.equal(payload.error.retryable, false);
    assert.equal(typeof payload.error.message, 'string');
  }
  const oversized = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(262145) }] }));
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).error.code, 'VALIDATION_ERROR');
});

test('GET /api/chat is refused because the endpoint is POST-only', async (t) => {
  const base = await serve(t, { env: {} });
  const response = await fetch(base + '/api/chat');
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'VALIDATION_ERROR');
});

test('POST /api/chat reports an unconfigured backend without contacting a provider', async (t) => {
  const base = await serve(t, { env: {}, fetchImpl: async () => { throw new Error('unexpected network call'); } });
  const response = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }));
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'PROVIDER_ERROR');
  assert.equal(payload.error.message, 'Chat backend is not configured.');
  assert.equal(payload.error.retryable, false);
});

test('POST /api/chat returns the assistant reply when the provider succeeds', async (t) => {
  const base = await serve(t, { env: { ANTHROPIC_API_KEY: 'integration-test-key' }, fetchImpl: async () => anthropicResponse() });
  const response = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json/);
  const payload = await response.json();
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { reply: 'Enjoy your coffee.', model: 'claude-sonnet-5', usage: { input_tokens: 9, output_tokens: 5 } });
});

test('POST /api/chat hides provider failures behind a retryable envelope', async (t) => {
  const base = await serve(t, { env: { ANTHROPIC_API_KEY: 'integration-test-key' }, fetchImpl: async () => new Response('fictional upstream error body', { status: 529 }) });
  const response = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }));
  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'PROVIDER_ERROR');
  assert.equal(payload.error.retryable, true);
  assert.doesNotMatch(payload.error.message, /fictional upstream|529|integration-test-key/);
});
