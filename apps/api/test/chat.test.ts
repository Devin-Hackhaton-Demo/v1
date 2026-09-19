import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import Fastify from 'fastify';
import { chatResponseSchema } from '@demo/contracts';
import { buildApp } from '../src/app.js';
import { DEFAULT_SYSTEM_PROMPT, registerChatRoute } from '../src/chat.js';
import { loadConfig } from '../src/config.js';

const API_KEY = 'sk-ant-KEY_SENTINEL';
const validPayload = {
  messages: [
    { role: 'user', content: 'Hello?' },
    { role: 'assistant', content: 'Yes?' },
    { role: 'user', content: 'Greet the world.' },
  ],
  system: 'Be concise.',
};

type FetchArgs = Parameters<typeof fetch>;
type StubCall = { url: string; init: NonNullable<FetchArgs[1]> };

function collectLogs() {
  const messages: string[] = [];
  const logStream = new Writable({
    write(chunk, _encoding, callback) {
      messages.push(String(chunk));
      callback();
    },
  });
  return { messages, logStream };
}

function createChatApp(t: TestContext, options: {
  withKey?: boolean;
  model?: string;
  responder?: () => Response;
  logStream?: Writable;
} = {}) {
  const calls: StubCall[] = [];
  const chatFetch = (async (...args: FetchArgs) => {
    calls.push({ url: String(args[0]), init: args[1] ?? {} });
    if (!options.responder) throw new Error('UNEXPECTED_UPSTREAM_CALL');
    return options.responder();
  }) as typeof fetch;
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: options.logStream ? 'info' : 'silent',
    ...(options.withKey === false ? {} : { ANTHROPIC_API_KEY: API_KEY }),
    ...(options.model === undefined ? {} : { ANTHROPIC_MODEL: options.model }),
  });
  const app = buildApp(config, {
    chatFetch,
    ...(options.logStream ? { logStream: options.logStream } : {}),
  });
  t.after(() => app.close());
  return { app, calls };
}

function createRateLimitedApp(t: TestContext, rateLimit: { limit: number; windowMs: number }) {
  const app = Fastify({ genReqId: () => randomUUID() });
  const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', ANTHROPIC_API_KEY: API_KEY });
  registerChatRoute(app, config, (async () => anthropicResponse()) as typeof fetch, { rateLimit });
  t.after(() => app.close());
  return app;
}

function anthropicResponse() {
  return new Response(JSON.stringify({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-5',
    content: [
      { type: 'text', text: 'Hello' },
      { type: 'tool_use', id: 'toolu_1', name: 'noop', input: {} },
      { type: 'text', text: ' world.' },
    ],
    stop_reason: 'end_turn',
    usage: { input_tokens: 17, output_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('rejects malformed chat requests with a sanitized validation envelope', async (t) => {
  const { app, calls } = createChatApp(t);
  for (const payload of [
    {},
    { messages: [] },
    { messages: [{ role: 'system', content: 'hi' }] },
    { messages: [{ role: 'user', content: '' }] },
    { messages: [{ role: 'user', content: 'hi' }], extra: true },
    { messages: [{ role: 'user', content: 'hi', extra: true }] },
    { messages: [{ role: 'assistant', content: 'hi' }] },
    { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }] },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload });
    assert.equal(response.statusCode, 400);
    const envelope = chatResponseSchema.parse(response.json());
    assert.equal(envelope.ok, false);
    if (!envelope.ok) {
      assert.deepEqual(envelope.error, {
        code: 'VALIDATION_ERROR', message: 'Invalid chat request.', retryable: false,
      });
    }
    assert.equal(envelope.request_id, response.headers['x-request-id']);
  }
  assert.equal(calls.length, 0);
});

test('reports an unconfigured chat backend without calling upstream', async (t) => {
  const { app, calls } = createChatApp(t, { withKey: false });
  const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload });
  assert.equal(response.statusCode, 503);
  const envelope = chatResponseSchema.parse(response.json());
  assert.equal(envelope.ok, false);
  if (!envelope.ok) {
    assert.deepEqual(envelope.error, {
      code: 'PROVIDER_ERROR', message: 'Chat backend is not configured.', retryable: false,
    });
  }
  assert.equal(calls.length, 0);
});

for (const [name, responder, expectedLog] of [
  ['an upstream error status', () => new Response('{"error":{"message":"UPSTREAM_SENTINEL"}}', { status: 500 }), 'Chat upstream rejected the request.'],
  ['an upstream network failure', () => { throw new Error('NETWORK_SENTINEL'); }, 'Chat upstream request failed.'],
  ['an unexpected upstream body', () => new Response('UPSTREAM_SENTINEL is not JSON', { status: 200 }), 'Chat upstream returned an unexpected response.'],
] as const) {
  test(`maps ${name} to a sanitized 502 without leaking details`, async (t) => {
    const { messages, logStream } = collectLogs();
    const { app } = createChatApp(t, { logStream, responder });
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload });
    assert.equal(response.statusCode, 502);
    const envelope = chatResponseSchema.parse(response.json());
    assert.equal(envelope.ok, false);
    if (!envelope.ok) {
      assert.deepEqual(envelope.error, {
        code: 'PROVIDER_ERROR', message: 'Upstream provider error.', retryable: true,
      });
    }
    const logs = messages.join('');
    assert.ok(logs.includes(expectedLog));
    for (const sentinel of ['UPSTREAM_SENTINEL', 'NETWORK_SENTINEL', 'KEY_SENTINEL', 'Greet the world.', 'Be concise.']) {
      assert.equal(response.body.includes(sentinel), false);
      assert.equal(logs.includes(sentinel), false);
    }
  });
}

test('proxies a chat exchange and concatenates upstream text blocks', async (t) => {
  const { messages, logStream } = collectLogs();
  const { app, calls } = createChatApp(t, { logStream, responder: anthropicResponse, model: 'claude-test-model' });
  const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload });
  assert.equal(response.statusCode, 200);
  const envelope = chatResponseSchema.parse(response.json());
  assert.equal(envelope.ok, true);
  if (envelope.ok) {
    assert.deepEqual(envelope.data, {
      reply: 'Hello world.',
      model: 'claude-sonnet-5',
      usage: { input_tokens: 17, output_tokens: 5 },
    });
  }
  assert.equal(envelope.request_id, response.headers['x-request-id']);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.ok(call);
  assert.equal(call.url, 'https://api.anthropic.com/v1/messages');
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get('x-api-key'), API_KEY);
  assert.equal(headers.get('anthropic-version'), '2023-06-01');
  assert.equal(headers.get('content-type'), 'application/json');
  assert.ok(call.init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(String(call.init.body)), {
    model: 'claude-test-model',
    max_tokens: 1024,
    messages: validPayload.messages,
    system: 'Be concise.',
  });
  const logs = messages.join('');
  assert.match(logs, /Request completed/);
  for (const sentinel of [API_KEY, 'KEY_SENTINEL', 'Hello world.', 'Greet the world.', 'Be concise.']) {
    assert.equal(logs.includes(sentinel), false);
  }
});

test('falls back to the default Anthropic model and the default system prompt', async (t) => {
  const { app, calls } = createChatApp(t, { responder: anthropicResponse });
  const response = await app.inject({
    method: 'POST', url: '/api/chat',
    payload: { messages: [{ role: 'user', content: 'Greet the world.' }] },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(chatResponseSchema.parse(response.json()).ok, true);
  const call = calls[0];
  assert.ok(call);
  const body: unknown = JSON.parse(String(call.init.body));
  assert.ok(typeof body === 'object' && body !== null);
  assert.equal((body as { system?: unknown }).system, DEFAULT_SYSTEM_PROMPT);
  assert.equal((body as { model?: unknown }).model, 'claude-sonnet-5');
  assert.equal((body as { max_tokens?: unknown }).max_tokens, 1024);
});

test('lets a caller-provided system prompt override the default', async (t) => {
  const { app, calls } = createChatApp(t, { responder: anthropicResponse });
  const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload });
  assert.equal(response.statusCode, 200);
  const call = calls[0];
  assert.ok(call);
  const body: unknown = JSON.parse(String(call.init.body));
  assert.ok(typeof body === 'object' && body !== null);
  assert.equal((body as { system?: unknown }).system, 'Be concise.');
  assert.notEqual((body as { system?: unknown }).system, DEFAULT_SYSTEM_PROMPT);
});

test('rate limits repeated chat requests with a retryable envelope and Retry-After', async (t) => {
  const app = createRateLimitedApp(t, { limit: 2, windowMs: 60_000 });
  for (let i = 0; i < 2; i += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload });
    assert.equal(response.statusCode, 200);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload });
  assert.equal(limited.statusCode, 429);
  const envelope = chatResponseSchema.parse(limited.json());
  assert.equal(envelope.ok, false);
  if (!envelope.ok) {
    assert.deepEqual(envelope.error, {
      code: 'LIMIT_EXCEEDED', message: 'Too many requests. Please wait a moment and try again.', retryable: true,
    });
  }
  assert.match(String(limited.headers['retry-after']), /^\d+$/);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});

test('allows chat requests again once the rate limit window has passed', async (t) => {
  const app = createRateLimitedApp(t, { limit: 1, windowMs: 50 });
  assert.equal((await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload })).statusCode, 429);
  await sleep(75);
  assert.equal((await app.inject({ method: 'POST', url: '/api/chat', payload: validPayload })).statusCode, 200);
});
