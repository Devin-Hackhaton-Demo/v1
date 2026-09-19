import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const ORIGIN = 'http://127.0.0.1:3000';
const CSRF = 'c'.repeat(43);
const ACCESS = 'ACCESS_TOKEN_SENTINEL';
const REFRESH = 'REFRESH_TOKEN_SENTINEL';
const consent = { accepted: true, version: '2026-09-19' };
const payload = { messages: [{ role: 'user', content: 'MESSAGE_SENTINEL' }] };
const anonymousHeaders = {
  origin: ORIGIN,
  cookie: `coffeenator-csrf=${CSRF}`,
  'x-csrf-token': CSRF,
};
const authenticatedHeaders = {
  ...anonymousHeaders,
  cookie: `${anonymousHeaders.cookie}; coffeenator-access=${ACCESS}; coffeenator-refresh=${REFRESH}`,
};

type AuthCall = { url: URL; headers: Headers; method: string | undefined };

function createApp(t: TestContext, options: {
  env?: NodeJS.ProcessEnv;
  metadata?: Record<string, unknown>;
  authResponder?: typeof fetch;
} = {}) {
  const authCalls: AuthCall[] = [];
  const chatCalls: Parameters<typeof fetch>[] = [];
  const logs: string[] = [];
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    SUPABASE_URL: 'https://auth.example.test',
    SUPABASE_ANON_KEY: 'ANON_KEY_SENTINEL',
    ANTHROPIC_API_KEY: 'ANTHROPIC_KEY_SENTINEL',
    ...options.env,
  });
  const app = buildApp(config, {
    logStream: new Writable({
      write(chunk, _encoding, callback) {
        logs.push(String(chunk));
        callback();
      },
    }),
    authFetch: async (input, init) => {
      const url = new URL(String(input));
      const headers = new Headers(init?.headers);
      authCalls.push({ url, headers, method: init?.method });
      if (options.authResponder) return options.authResponder(input, init);
      if (url.pathname === '/auth/v1/user' && headers.get('authorization') === `Bearer ${ACCESS}`) {
        return Response.json({
          id: 'verified-user',
          email: 'person@example.test',
          user_metadata: options.metadata ?? { ai_processing_consent: consent },
        });
      }
      return Response.json({ code: 'bad_jwt', message: 'UPSTREAM_SECRET_SENTINEL' }, { status: 401 });
    },
    chatFetch: async (...args) => {
      chatCalls.push(args);
      return Response.json({
        model: 'claude-test',
        content: [{ type: 'text', text: 'Hello.' }],
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  t.after(() => app.close());
  return { app, config, authCalls, chatCalls, logs };
}

test('anonymous chat is rejected before parsing or spending Anthropic tokens', async (t) => {
  const { app, authCalls, chatCalls } = createApp(t);
  for (const body of [payload, '{invalid']) {
    const response = await app.inject({
      method: 'POST', url: '/api/chat', payload: body,
      headers: { ...anonymousHeaders, 'content-type': 'application/json' },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(response.json().error.code, 'AUTH_REQUIRED');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.match(String(response.headers['x-request-id']), /^[0-9a-f-]{36}$/);
  }
  assert.equal(authCalls.length, 0);
  assert.equal(chatCalls.length, 0);
});

test('forged cookies and client identity headers cannot authenticate chat or reach Anthropic', async (t) => {
  const { app, authCalls, chatCalls, logs } = createApp(t);
  const forged = Buffer.from(JSON.stringify({ sub: 'verified-user', ai_processing_consent: consent })).toString('base64url');
  const response = await app.inject({
    method: 'POST', url: '/api/chat', payload,
    headers: {
      ...authenticatedHeaders,
      cookie: `${anonymousHeaders.cookie}; coffeenator-access=forged.${forged}.signature; coffeenator-refresh=FORGED_REFRESH_SENTINEL`,
      authorization: `Bearer ${ACCESS}`,
      'x-user-id': 'verified-user',
    },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error.code, 'AUTH_REQUIRED');
  assert.ok(authCalls.some((call) => call.url.pathname === '/auth/v1/user'));
  assert.ok(authCalls.some((call) => call.url.searchParams.get('grant_type') === 'refresh_token'));
  assert.equal(chatCalls.length, 0);
  assert.match(String(response.headers['set-cookie']), /Max-Age=0/);
  for (const secret of [ACCESS, REFRESH, forged, 'FORGED_REFRESH_SENTINEL', 'UPSTREAM_SECRET_SENTINEL', 'ANON_KEY_SENTINEL', 'MESSAGE_SENTINEL']) {
    assert.equal(response.body.includes(secret), false);
    assert.equal(logs.join('').includes(secret), false);
  }
});

test('chat requires explicit current AI consent from the verified Supabase user', async (t) => {
  for (const metadata of [
    {},
    { ai_processing_consent: { accepted: false, version: consent.version } },
    { ai_processing_consent: { accepted: true, version: 'outdated' } },
    { ai_processing_consent: { accepted: 'true', version: consent.version } },
  ]) {
    const { app, authCalls, chatCalls } = createApp(t, { metadata });
    const response = await app.inject({
      method: 'POST', url: '/api/chat', headers: authenticatedHeaders,
      payload: { ...payload, ai_processing_consent: consent },
    });
    assert.equal(response.statusCode, 403);
    assert.equal(response.json().error.code, 'CONSENT_REQUIRED');
    assert.equal(authCalls.length, 1);
    assert.equal(chatCalls.length, 0);
  }
});

test('chat rejects missing or mismatched CSRF and noncanonical Origin before upstream calls', async (t) => {
  const { app, authCalls, chatCalls } = createApp(t);
  const cases: Record<string, string>[] = [
    {},
    { ...authenticatedHeaders, 'x-csrf-token': '' },
    { ...authenticatedHeaders, 'x-csrf-token': 'mismatch' },
    { ...authenticatedHeaders, cookie: `coffeenator-access=${ACCESS}; coffeenator-refresh=${REFRESH}` },
    { ...authenticatedHeaders, origin: '' },
    { ...authenticatedHeaders, origin: 'http://localhost:3000' },
    { ...authenticatedHeaders, origin: 'http://127.0.0.1:3001', 'x-forwarded-host': '127.0.0.1:3001' },
    { ...authenticatedHeaders, 'sec-fetch-site': 'cross-site' },
    { ...authenticatedHeaders, origin: 'https://external.invalid' },
    { ...authenticatedHeaders, host: 'external.invalid' },
  ];
  for (const headers of cases) {
    const response = await app.inject({ method: 'POST', url: '/api/chat', headers, payload });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(authCalls.length, 0);
  assert.equal(chatCalls.length, 0);
});

test('unconfigured or unavailable authentication fails closed without calling Anthropic', async (t) => {
  for (const options of [
    { env: { SUPABASE_URL: undefined, SUPABASE_ANON_KEY: undefined } },
    { authResponder: async () => Response.json({ message: 'UPSTREAM_SECRET_SENTINEL' }, { status: 503 }) },
    { authResponder: async () => { throw new Error('NETWORK_SECRET_SENTINEL'); } },
  ]) {
    const { app, chatCalls, logs } = createApp(t, options);
    const response = await app.inject({ method: 'POST', url: '/api/chat', headers: authenticatedHeaders, payload });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, 'AUTH_UNAVAILABLE');
    assert.equal(chatCalls.length, 0);
    assert.doesNotMatch(response.body + logs.join(''), /UPSTREAM_SECRET_SENTINEL|NETWORK_SECRET_SENTINEL/);
    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { status: 'ok', mode: 'local' });
  }
});

test('consented sessions are verified for every request without leaking authentication state', async (t) => {
  const { app, authCalls, chatCalls, logs } = createApp(t);
  const responses = await Promise.all([
    app.inject({ method: 'POST', url: '/api/chat', headers: authenticatedHeaders, payload }),
    app.inject({ method: 'POST', url: '/api/chat', headers: anonymousHeaders, payload }),
    app.inject({ method: 'POST', url: '/api/chat', headers: authenticatedHeaders, payload }),
  ]);
  assert.deepEqual(responses.map((response) => response.statusCode), [200, 401, 200]);
  assert.equal(authCalls.length, 2);
  assert.equal(chatCalls.length, 2);
  for (const call of authCalls) {
    assert.equal(call.url.href, 'https://auth.example.test/auth/v1/user');
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.get('authorization'), `Bearer ${ACCESS}`);
    assert.equal(call.headers.get('apikey'), 'ANON_KEY_SENTINEL');
  }
  for (const call of chatCalls) {
    const serialized = JSON.stringify(call);
    assert.equal(serialized.includes(ACCESS), false);
    assert.equal(serialized.includes(REFRESH), false);
  }
  for (const secret of [ACCESS, REFRESH, 'ANON_KEY_SENTINEL', 'ANTHROPIC_KEY_SENTINEL', 'MESSAGE_SENTINEL']) {
    assert.equal(logs.join('').includes(secret), false);
  }
});

test('the production chat route retains its rate limit for authenticated consented requests', async (t) => {
  const { app, chatCalls } = createApp(t);
  for (let index = 0; index < 10; index += 1) {
    const response = await app.inject({ method: 'POST', url: '/api/chat', headers: authenticatedHeaders, payload });
    assert.equal(response.statusCode, 200);
  }
  const response = await app.inject({ method: 'POST', url: '/api/chat', headers: authenticatedHeaders, payload });
  assert.equal(response.statusCode, 429);
  assert.equal(response.json().error.code, 'LIMIT_EXCEEDED');
  assert.match(String(response.headers['retry-after']), /^\d+$/);
  assert.equal(chatCalls.length, 10);
});

test('auth configuration uses the configured local port or explicit canonical origin', async (t) => {
  for (const env of [
    { PORT: '4317' },
    { PORT: '4317', APP_ORIGIN: 'http://localhost:4317' },
  ]) {
    const { app, config, chatCalls } = createApp(t, { env });
    assert.equal(config.appOrigin, env.APP_ORIGIN ?? 'http://127.0.0.1:4317');
    assert.equal(config.supabaseUrl, 'https://auth.example.test');
    assert.equal(config.supabaseAnonKey, 'ANON_KEY_SENTINEL');
    const response = await app.inject({
      method: 'POST', url: '/api/chat', payload,
      headers: { ...authenticatedHeaders, origin: config.appOrigin! },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(chatCalls.length, 1);
  }
});
