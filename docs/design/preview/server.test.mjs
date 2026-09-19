import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createPreviewServer } from './server.mjs';
import { callAnthropic, createRateLimiter, DEFAULT_SYSTEM_PROMPT, MAX_CHAT_BODY_BYTES, validateChatRequest } from '../../../api/_lib/anthropic.mjs';
import { bearerToken } from '../../../api/_lib/connections.mjs';

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

test('callAnthropic applies the default system prompt when the caller provides none', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return anthropicResponse();
  };
  await callAnthropic({ messages: [{ role: 'user', content: 'Hi' }] }, { ANTHROPIC_API_KEY: 'unit-test-key' }, fetchImpl);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init.body).system, DEFAULT_SYSTEM_PROMPT);
  assert.match(DEFAULT_SYSTEM_PROMPT, /Coffeenator/);
  assert.match(DEFAULT_SYSTEM_PROMPT, /same language/);
});

test('callAnthropic keeps a caller-provided system prompt unchanged', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return anthropicResponse();
  };
  await callAnthropic({ messages: [{ role: 'user', content: 'Hi' }], system: 'Answer only about coffee.' }, { ANTHROPIC_API_KEY: 'unit-test-key' }, fetchImpl);
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.system, 'Answer only about coffee.');
  assert.notEqual(sent.system, DEFAULT_SYSTEM_PROMPT);
});

test('createRateLimiter enforces a per-IP sliding window and recovers after it passes', () => {
  let current = 1_000_000;
  const limiter = createRateLimiter({ limit: 2, windowMs: 60000, now: () => current });
  assert.deepEqual(limiter.check('10.0.0.1'), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.check('10.0.0.1'), { allowed: true, retryAfterSeconds: 0 });
  const blocked = limiter.check('10.0.0.1');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds >= 1 && blocked.retryAfterSeconds <= 60);
  assert.equal(limiter.check('10.0.0.2').allowed, true, 'other IPs are counted independently');
  current += 60001;
  assert.deepEqual(limiter.check('10.0.0.1'), { allowed: true, retryAfterSeconds: 0 }, 'stale entries are pruned once the window passes');
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

test('POST /api/chat rate limits the 11th rapid request from the same IP', async (t) => {
  const base = await serve(t, {
    env: { ANTHROPIC_API_KEY: 'integration-test-key' },
    fetchImpl: async () => anthropicResponse(),
    rateLimiter: createRateLimiter(),
  });
  const body = JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] });
  for (let i = 0; i < 10; i += 1) {
    const response = await postChat(base, body);
    assert.equal(response.status, 200, `request ${i + 1} stays within the default limit`);
    await response.json();
  }
  const limited = await postChat(base, body);
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, 'Retry-After is a plausible number of seconds');
  const payload = await limited.json();
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'LIMIT_EXCEEDED');
  assert.equal(payload.error.message, 'Too many requests. Please wait a moment and try again.');
  assert.equal(payload.error.retryable, true);
});

test('the rate limit does not bleed between servers because each gets its own limiter', async (t) => {
  const base = await serve(t, { env: { ANTHROPIC_API_KEY: 'integration-test-key' }, fetchImpl: async () => anthropicResponse() });
  const response = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }));
  assert.equal(response.status, 200);
});

// --- Chat image contract -----------------------------------------------------

const VALID_BASE64 = 'aGVsbG8gd29ybGQ='; // shape check only; never decoded
const imageBlock = (overrides = {}) => ({ type: 'image', media_type: 'image/png', data: VALID_BASE64, ...overrides });

test('chat validation accepts block-array messages with text and images', () => {
  assert.deepEqual(validateChatRequest({ messages: [{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, imageBlock()] }] }), { ok: true, errors: [] });
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: [imageBlock({ media_type: 'image/jpeg' })] }] }).ok, true, 'an image-only message is valid');
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: [imageBlock(), imageBlock(), imageBlock(), imageBlock()] }] }).ok, true, 'four images per request are allowed');
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: 'plain string content' }] }).ok, true, 'string content keeps working');
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: [imageBlock({ data: 'A'.repeat(2800000) })] }] }).ok, true, 'the base64 budget itself is allowed');
});

test('chat validation rejects malformed or oversized block-array messages', () => {
  const rejected = [
    [{ role: 'user', content: [] }],
    [{ role: 'user', content: Array.from({ length: 9 }, () => ({ type: 'text', text: 'Hi' })) }],
    [{ role: 'user', content: [imageBlock(), imageBlock(), imageBlock(), imageBlock(), imageBlock()] }],
    [{ role: 'user', content: [imageBlock(), imageBlock(), imageBlock()] }, { role: 'assistant', content: 'Seen.' }, { role: 'user', content: [imageBlock(), imageBlock()] }],
    [{ role: 'user', content: [imageBlock({ media_type: 'image/tiff' })] }],
    [{ role: 'user', content: [imageBlock({ data: 'not base64 $$' })] }],
    [{ role: 'user', content: [imageBlock({ data: 'abc' })] }],
    [{ role: 'user', content: [imageBlock({ data: '' })] }],
    [{ role: 'user', content: [imageBlock({ data: 'A'.repeat(2800004) })] }],
    [{ role: 'user', content: [imageBlock({ extra: true })] }],
    [{ role: 'user', content: [{ type: 'image', media_type: 'image/png' }] }],
    [{ role: 'user', content: [{ type: 'text', text: 'Hi', extra: true }] }],
    [{ role: 'user', content: [{ type: 'text', text: '' }] }],
    [{ role: 'user', content: [{ type: 'tool_use', id: 'x' }] }],
    [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(40000) }, { type: 'text', text: 'x'.repeat(30000) }] }],
  ];
  for (const [index, messages] of rejected.entries()) {
    const result = validateChatRequest({ messages });
    assert.equal(result.ok, false, `rejected[${index}]`);
    assert.ok(result.errors.length > 0, `rejected[${index}]`);
  }
});

test('POST /api/chat maps mixed text and image content to Anthropic base64 source blocks', async (t) => {
  const calls = [];
  const base = await serve(t, {
    env: { ANTHROPIC_API_KEY: 'integration-test-key' },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return anthropicResponse(); },
  });
  const response = await postChat(base, JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'What is on this screenshot?' }, imageBlock()] }],
  }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).ok, true);
  assert.equal(calls.length, 1);
  const sent = JSON.parse(calls[0].init.body);
  assert.deepEqual(sent.messages, [{
    role: 'user',
    content: [
      { type: 'text', text: 'What is on this screenshot?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: VALID_BASE64 } },
    ],
  }]);
});

test('POST /api/chat rejects image contract violations with 400 envelopes', async (t) => {
  const base = await serve(t, { env: { ANTHROPIC_API_KEY: 'integration-test-key' }, fetchImpl: async () => { throw new Error('unexpected network call'); } });
  const cases = [
    { messages: [{ role: 'user', content: [imageBlock(), imageBlock(), imageBlock(), imageBlock(), imageBlock()] }] },
    { messages: [{ role: 'user', content: [imageBlock({ data: 'A'.repeat(2800004) })] }] },
    { messages: [{ role: 'user', content: [imageBlock({ media_type: 'image/bmp' })] }] },
  ];
  for (const [index, body] of cases.entries()) {
    const response = await postChat(base, JSON.stringify(body));
    assert.equal(response.status, 400, `cases[${index}]`);
    const payload = await response.json();
    assert.equal(payload.error.code, 'VALIDATION_ERROR', `cases[${index}]`);
  }
});

test('POST /api/chat accepts large image bodies but rejects anything above 4 MiB', async (t) => {
  assert.equal(MAX_CHAT_BODY_BYTES, 4194304);
  const base = await serve(t, { env: { ANTHROPIC_API_KEY: 'integration-test-key' }, fetchImpl: async () => anthropicResponse() });
  // ~2.8 MB body: far above the old 256 KiB cap, within the new 4 MiB chat cap.
  const large = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: [imageBlock({ data: 'A'.repeat(2800000) })] }] }));
  assert.equal(large.status, 200);
  const oversized = await postChat(base, JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(MAX_CHAT_BODY_BYTES) }] }));
  assert.equal(oversized.status, 400);
  const payload = await oversized.json();
  assert.equal(payload.error.code, 'VALIDATION_ERROR');
  assert.match(payload.error.message, /4 MiB/);
});

// --- User connections backend ------------------------------------------------

const SUPABASE_URL = 'https://supabase.example.test';
const SUPABASE_ENV = { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-test-key', SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-key' };
const CONNECTION_ID = '11111111-2222-4333-8444-555555555555';
const USER_JWT = 'user-jwt-token';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

function postJson(base, path, body, headers = {}) {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

const neverFetch = async () => { throw new Error('unexpected network call'); };

test('bearerToken extracts JWTs and rejects malformed Authorization headers', () => {
  assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(bearerToken('bearer lower-case'), 'lower-case');
  for (const bad of [undefined, '', 'abc', 'Basic abc', 'Bearer ', 'Bearer two tokens']) assert.equal(bearerToken(bad), '');
});

test('POST /api/auth/login exchanges credentials with GoTrue and returns a session', async (t) => {
  const calls = [];
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ access_token: 'session-access-token', refresh_token: 'session-refresh-token', expires_in: 3600, user: { id: 'user-1', email: 'owner@demo.test', role: 'authenticated' } });
    },
  });
  const response = await postJson(base, '/api/auth/login', { email: 'owner@demo.test', password: 'correct horse' });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.schema_version, 1);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, {
    access_token: 'session-access-token',
    refresh_token: 'session-refresh-token',
    expires_in: 3600,
    user: { id: 'user-1', email: 'owner@demo.test' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SUPABASE_URL}/auth/v1/token?grant_type=password`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.apikey, 'anon-test-key');
  assert.deepEqual(JSON.parse(calls[0].init.body), { email: 'owner@demo.test', password: 'correct horse' });
});

test('POST /api/auth/login maps GoTrue 400 to a 401 without echoing upstream details', async (t) => {
  const base = await serve(t, { env: SUPABASE_ENV, fetchImpl: async () => jsonResponse({ error: 'invalid_grant', error_description: 'fictional upstream detail' }, 400) });
  const response = await postJson(base, '/api/auth/login', { email: 'owner@demo.test', password: 'wrong' });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'UNAUTHENTICATED');
  assert.equal(payload.error.message, 'Invalid email or password.');
  assert.doesNotMatch(JSON.stringify(payload), /invalid_grant|fictional upstream/);
});

test('POST /api/auth/login rejects invalid bodies before contacting GoTrue', async (t) => {
  const base = await serve(t, { env: SUPABASE_ENV, fetchImpl: neverFetch });
  for (const body of [{}, { email: 42, password: 'x' }, { email: 'not-an-email', password: 'x' }, { email: 'a@b.test', password: '' }, { email: 'a@b.test', password: 'x', extra: true }]) {
    const response = await postJson(base, '/api/auth/login', body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'VALIDATION_ERROR');
  }
});

test('POST /api/auth/login rate limits the 6th rapid attempt from the same IP', async (t) => {
  const base = await serve(t, { env: SUPABASE_ENV, fetchImpl: async () => jsonResponse({ error: 'invalid_grant' }, 400) });
  for (let i = 0; i < 5; i += 1) {
    const response = await postJson(base, '/api/auth/login', { email: 'owner@demo.test', password: 'guess' });
    assert.equal(response.status, 401, `attempt ${i + 1} stays within the login limit`);
    await response.json();
  }
  const limited = await postJson(base, '/api/auth/login', { email: 'owner@demo.test', password: 'guess' });
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get('retry-after'));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60);
  assert.equal((await limited.json()).error.code, 'LIMIT_EXCEEDED');
});

test('POST /api/auth/refresh renews a session and maps failures to 401', async (t) => {
  const calls = [];
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      if (JSON.parse(init.body).refresh_token === 'still-valid') {
        return jsonResponse({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600, user: { id: 'user-1', email: 'owner@demo.test' } });
      }
      return jsonResponse({ error: 'invalid_grant' }, 400);
    },
  });
  const renewed = await postJson(base, '/api/auth/refresh', { refresh_token: 'still-valid' });
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).data.access_token, 'new-access');
  assert.equal(calls[0].url, `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`);
  const expired = await postJson(base, '/api/auth/refresh', { refresh_token: 'expired-token' });
  assert.equal(expired.status, 401);
  const payload = await expired.json();
  assert.equal(payload.error.code, 'UNAUTHENTICATED');
  assert.equal(payload.error.message, 'Session expired. Sign in again.');
});

test('GET /api/connections requires a bearer token before touching the network', async (t) => {
  const base = await serve(t, { env: SUPABASE_ENV, fetchImpl: neverFetch });
  const response = await fetch(base + '/api/connections');
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error.code, 'UNAUTHENTICATED');
  assert.equal(payload.error.message, 'Sign in required.');
});

test('GET /api/connections lists active rows through PostgREST under the user JWT', async (t) => {
  const rows = [{ id: CONNECTION_ID, provider: 'github', label: 'work', scopes: [], created_at: '2026-09-19T12:00:00Z' }];
  const calls = [];
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: async (url, init = {}) => { calls.push({ url: String(url), init }); return jsonResponse(rows); },
  });
  const response = await fetch(base + '/api/connections', { headers: { authorization: `Bearer ${USER_JWT}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { connections: rows });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SUPABASE_URL}/rest/v1/user_connections?select=id,provider,label,scopes,created_at&revoked_at=is.null&order=created_at.desc`);
  assert.equal(calls[0].init.headers.apikey, 'anon-test-key');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${USER_JWT}`);
});

test('POST /api/connections rejects unknown providers and points Google to OAuth', async (t) => {
  const base = await serve(t, { env: SUPABASE_ENV, fetchImpl: neverFetch });
  const auth = { authorization: `Bearer ${USER_JWT}` };
  const unknown = await postJson(base, '/api/connections', { provider: 'aws', secret: 'x' }, auth);
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, 'VALIDATION_ERROR');
  const google = await postJson(base, '/api/connections', { provider: 'google', secret: 'x' }, auth);
  assert.equal(google.status, 400);
  const payload = await google.json();
  assert.equal(payload.error.code, 'VALIDATION_ERROR');
  assert.equal(payload.error.message, 'Google connects via OAuth.');
  const oversized = await postJson(base, '/api/connections', { provider: 'github', secret: 'x'.repeat(4097) }, auth);
  assert.equal(oversized.status, 400);
});

test('POST /api/connections stores the secret via RPC exactly once and never echoes it', async (t) => {
  const secret = 'ghp_fictional_test_secret_value';
  const calls = [];
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: CONNECTION_ID, user_id: 'user-1', provider: 'github', label: 'work', scopes: [], metadata: {}, created_at: '2026-09-19T12:00:00Z', updated_at: '2026-09-19T12:00:00Z', revoked_at: null });
    },
  });
  const response = await postJson(base, '/api/connections', { provider: 'github', secret, label: 'work' }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.ok(!raw.includes(secret), 'the response never contains the secret');
  const payload = JSON.parse(raw);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { connection: { id: CONNECTION_ID, provider: 'github', label: 'work' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${SUPABASE_URL}/rest/v1/rpc/store_user_connection`);
  assert.equal(calls[0].init.headers.apikey, 'anon-test-key');
  assert.equal(calls[0].init.headers.authorization, `Bearer ${USER_JWT}`);
  const rpcBody = calls[0].init.body;
  assert.equal(rpcBody.split(secret).length - 1, 1, 'the RPC body carries the secret exactly once');
  assert.deepEqual(JSON.parse(rpcBody), { p_provider: 'github', p_secret: secret, p_label: 'work', p_scopes: [], p_metadata: {} });
});

test('POST /api/connections/revoke maps the RPC NOT_FOUND to a 404 for foreign ids', async (t) => {
  const base = await serve(t, { env: SUPABASE_ENV, fetchImpl: async () => jsonResponse({ code: 'P0001', message: 'NOT_FOUND', details: null, hint: null }, 400) });
  const response = await postJson(base, '/api/connections/revoke', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 404);
  const payload = await response.json();
  assert.equal(payload.error.code, 'NOT_FOUND');
  assert.equal(payload.error.message, 'Connection not found.');
});

test('POST /api/connections/revoke reports success with revoked:true', async (t) => {
  const calls = [];
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ id: CONNECTION_ID, provider: 'github', label: '', revoked_at: '2026-09-19T12:00:00Z' });
    },
  });
  const response = await postJson(base, '/api/connections/revoke', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, { revoked: true });
  assert.equal(calls[0].url, `${SUPABASE_URL}/rest/v1/rpc/revoke_user_connection`);
  assert.deepEqual(JSON.parse(calls[0].init.body), { p_connection_id: CONNECTION_ID });
});

// Dispatching stub for the three-step check flow: ownership row (user JWT),
// secret RPC (service role), then the provider health call.
function checkFetchStub({ seen, rowResponse, githubResponse }) {
  return async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith(`${SUPABASE_URL}/rest/v1/user_connections?`)) {
      seen.row = { url: target, init };
      return rowResponse();
    }
    if (target === `${SUPABASE_URL}/rest/v1/rpc/get_user_connection_secret`) {
      seen.rpc = { url: target, init };
      return jsonResponse('gh-fictional-secret');
    }
    if (target === 'https://api.github.com/user') {
      seen.github = { url: target, init };
      return githubResponse();
    }
    throw new Error(`unexpected URL ${target}`);
  };
}

test('POST /api/connections/check verifies ownership, reads the secret with the service role and reports healthy', async (t) => {
  const seen = {};
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: checkFetchStub({
      seen,
      rowResponse: () => jsonResponse([{ id: CONNECTION_ID, provider: 'github' }]),
      githubResponse: () => jsonResponse({ login: 'octocat' }),
    }),
  });
  const response = await postJson(base, '/api/connections/check', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { provider: 'github', healthy: true, account: 'octocat' });
  // (a) ownership through the user JWT (RLS scopes the row)
  assert.match(seen.row.url, new RegExp(`id=eq\\.${CONNECTION_ID}`));
  assert.equal(seen.row.init.headers.apikey, 'anon-test-key');
  assert.equal(seen.row.init.headers.authorization, `Bearer ${USER_JWT}`);
  // (b) secret through the service role key only
  assert.equal(seen.rpc.init.headers.apikey, 'service-role-test-key');
  assert.equal(seen.rpc.init.headers.authorization, 'Bearer service-role-test-key');
  assert.deepEqual(JSON.parse(seen.rpc.init.body), { p_connection_id: CONNECTION_ID });
  // (c) the documented GitHub health call, secret only in the outbound header
  assert.equal(seen.github.init.headers.Authorization, 'Bearer gh-fictional-secret');
  assert.equal(seen.github.init.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(seen.github.init.headers.Accept, 'application/vnd.github+json');
  assert.equal(seen.github.init.headers['User-Agent'], 'coffeenator');
  assert.ok(!JSON.stringify(payload).includes('gh-fictional-secret'), 'the response never contains the secret');
});

test('POST /api/connections/check reports unauthorized when the provider rejects the credential', async (t) => {
  const seen = {};
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: checkFetchStub({
      seen,
      rowResponse: () => jsonResponse([{ id: CONNECTION_ID, provider: 'github' }]),
      githubResponse: () => jsonResponse({ message: 'Bad credentials' }, 401),
    }),
  });
  const response = await postJson(base, '/api/connections/check', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { provider: 'github', healthy: false, reason: 'unauthorized' });
});

test('POST /api/connections/check reports unreachable on network failure', async (t) => {
  const seen = {};
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: checkFetchStub({
      seen,
      rowResponse: () => jsonResponse([{ id: CONNECTION_ID, provider: 'github' }]),
      githubResponse: () => { throw new Error('connect ECONNREFUSED'); },
    }),
  });
  const response = await postJson(base, '/api/connections/check', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.data, { provider: 'github', healthy: false, reason: 'unreachable' });
});

test('POST /api/connections/check returns 404 for foreign rows without reading any secret', async (t) => {
  const seen = {};
  const base = await serve(t, {
    env: SUPABASE_ENV,
    fetchImpl: checkFetchStub({
      seen,
      rowResponse: () => jsonResponse([]),
      githubResponse: () => { throw new Error('must not be reached'); },
    }),
  });
  const response = await postJson(base, '/api/connections/check', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
  assert.equal(seen.rpc, undefined, 'the service-role secret RPC is never called');
  assert.equal(seen.github, undefined, 'no provider call happens');
});

test('connection endpoints answer 503 when the Supabase env is not configured', async (t) => {
  const base = await serve(t, { env: {}, fetchImpl: neverFetch });
  const attempts = [
    postJson(base, '/api/auth/login', { email: 'a@b.test', password: 'x' }),
    postJson(base, '/api/auth/refresh', { refresh_token: 'x' }),
    fetch(base + '/api/connections', { headers: { authorization: `Bearer ${USER_JWT}` } }),
    postJson(base, '/api/connections', { provider: 'github', secret: 'x' }, { authorization: `Bearer ${USER_JWT}` }),
    postJson(base, '/api/connections/revoke', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` }),
    postJson(base, '/api/connections/check', { id: CONNECTION_ID }, { authorization: `Bearer ${USER_JWT}` }),
  ];
  for (const response of await Promise.all(attempts)) {
    assert.equal(response.status, 503);
    const payload = await response.json();
    assert.equal(payload.error.code, 'PROVIDER_ERROR');
    assert.equal(payload.error.message, 'Connections backend is not configured.');
  }
});
