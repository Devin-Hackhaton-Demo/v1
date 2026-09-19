import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { handleAuthRequest, requireAuth, requireAiConsent } from '../api/_lib/auth.mjs';

const env = { SUPABASE_URL: 'https://auth.example.test', SUPABASE_ANON_KEY: 'test-public-anon-key', APP_ORIGIN: 'https://app.example.test', AUTH_RECOVERY_SECRET: 'test-only-signing-key-with-more-than-32-bytes', NODE_ENV: 'production' };
const version = '2026-09-19';
const baseUser = { id: 'user-1', email: 'person@example.test', aud: 'authenticated', user_metadata: { full_name: 'Test Person' }, app_metadata: {}, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
const testEpoch = Math.floor(Date.now() / 1000);
const jwt = (expired = false, sid = 'session-1', method = 'password') => `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: 'user-1', session_id: sid, amr: [{ method, timestamp: testEpoch }], exp: testEpoch + (expired ? -10 : 3600) })).toString('base64url')}.test-signature`;
const session = (extra = {}) => ({ access_token: jwt(), refresh_token: 'refresh-valid', token_type: 'bearer', expires_in: 3600, user: structuredClone(baseUser), ...extra });
const ok = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
function backend() {
  const calls = [];
  let user = structuredClone(baseUser);
  let spent = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init.headers);
    calls.push({ url, method: init.method, body, headers });
    assert.equal(url.origin, env.SUPABASE_URL);
    if (url.pathname.endsWith('/user') && init.method === 'GET') {
      const token = headers.get('Authorization')?.replace('Bearer ', '');
      if (![jwt(), jwt(false, 'session-1', 'otp')].includes(token)) return ok({ code: 'bad_jwt', msg: 'UPSTREAM_SECRET invalid token' }, 401);
      return ok(user);
    }
    if (url.pathname.endsWith('/user') && init.method === 'PUT') {
      if (body.data) user = { ...user, user_metadata: { ...user.user_metadata, ...body.data } };
      user = { ...user, updated_at: new Date().toISOString() };
      return ok(user);
    }
    if (url.pathname.endsWith('/token')) {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'refresh_token' && body.refresh_token !== 'refresh-valid') return ok({ code: 'refresh_token_not_found', msg: 'UPSTREAM_SECRET' }, 400);
      if (grant === 'password' && body.password === 'wrong') return ok({ code: 'invalid_credentials', msg: 'UPSTREAM_SECRET' }, 400);
      if (grant === 'pkce' && !['valid-code', 'recovery-code'].includes(body.auth_code)) return ok({ code: 'bad_code_verifier', msg: 'UPSTREAM_SECRET' }, 400);
      if (grant === 'pkce' && body.auth_code === 'recovery-code') return ok(session({ user, access_token: jwt(false, 'session-1', 'otp') }));
      return ok(session({ user }));
    }
    if (url.pathname.endsWith('/signup')) return ok({ ...user, user_metadata: body.data || {} });
    if (url.pathname.endsWith('/recover')) return ok({});
    if (url.pathname.endsWith('/logout')) return new Response(null, { status: 204 });
    if (url.pathname.endsWith('/verify')) {
      if (body.token_hash !== 'valid-token' || spent) return ok({ code: 'otp_expired', msg: 'UPSTREAM_SECRET' }, 403);
      spent = true;
      return ok(session({ user }));
    }
    throw new Error('Unexpected mock endpoint');
  };
  return { calls, fetchImpl, setUser: (value) => { user = value; } };
}
let ipCounter = 0;
function browser(mock = backend(), customEnv = env) {
  const jar = new Map();
  const ip = `192.0.2.${++ipCounter}`;
  const request = async (path = '/api/auth/session', { method = 'GET', body, headers = {}, parsed = true, helper } = {}) => {
    const req = Readable.from(body === undefined || parsed ? [] : [typeof body === 'string' ? body : JSON.stringify(body)]);
    req.url = path;
    req.method = method;
    req.headers = { host: 'app.example.test', cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(method === 'POST' ? { origin: customEnv.APP_ORIGIN, 'content-type': 'application/json', 'x-csrf-token': jar.get('__Host-coffeenator-csrf') || jar.get('coffeenator-csrf') } : {}), ...headers };
    req.socket = { remoteAddress: ip };
    if (parsed && body !== undefined) req.body = body;
    const out = { status: 200, headers: {}, text: '' };
    const res = {
      setHeader(name, value) { out.headers[name.toLowerCase()] = value; },
      getHeader(name) { return out.headers[name.toLowerCase()]; },
      writeHead(status, values = {}) { out.status = status; for (const [key, value] of Object.entries(values)) this.setHeader(key, value); return this; },
      end(value = '') { out.text = value.toString(); this.writableEnded = true; },
    };
    out.returned = await (helper || handleAuthRequest)(req, res, { env: customEnv, fetchImpl: mock.fetchImpl });
    for (const cookie of out.headers['set-cookie'] || []) {
      const first = cookie.split(';')[0];
      const split = first.indexOf('=');
      const [key, value] = [first.slice(0, split), first.slice(split + 1)];
      if (cookie.includes('Max-Age=0')) jar.delete(key); else jar.set(key, value);
    }
    out.json = out.text.startsWith('{') ? JSON.parse(out.text) : null;
    return out;
  };
  return { mock, request, jar, authenticate: () => { jar.set('__Host-coffeenator-access', jwt()); jar.set('__Host-coffeenator-refresh', 'refresh-valid'); } };
}
const post = (body = {}) => ({ method: 'POST', body });
const terms = { termsAccepted: true, termsVersion: version };

test('anonymous session is no-store, issues only HttpOnly host-only CSRF, no upstream call', async () => {
  const b = browser();
  const result = await b.request();
  assert.equal(result.status, 200);
  assert.equal(result.json.data.user, null);
  assert.equal(result.json.data.aiConsent, false);
  assert.match(result.json.data.csrfToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(b.mock.calls.length, 0);
  for (const cookie of result.headers['set-cookie']) {
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/);
  }
});

test('forged sessions clear cookies and never accept cookie JSON identity', async () => {
  const b = browser();
  b.jar.set('__Host-coffeenator-access', 'forged'); b.jar.set('__Host-coffeenator-refresh', 'forged');
  const r = await b.request();
  assert.equal(r.json.data.user, null); assert.equal(b.jar.has('__Host-coffeenator-access'), false);
  assert.doesNotMatch(r.text, /UPSTREAM_SECRET|refresh_token|access_token/);
});

test('expired access refreshes and validates the newly issued token server-side', async () => {
  const b = browser(); b.authenticate(); b.jar.set('__Host-coffeenator-access', jwt(true));
  const r = await b.request();
  assert.equal(r.json.data.user.id, 'user-1');
  assert.ok(b.mock.calls.some((call) => call.url.searchParams.get('grant_type') === 'refresh_token'));
  assert.ok(b.mock.calls.filter((call) => call.url.pathname.endsWith('/user')).length >= 2);
  assert.equal(b.jar.get('__Host-coffeenator-access'), jwt());
});

test('mutation denies missing/mismatched CSRF, wrong/missing Origin, and forwarded-host tricks', async () => {
  const b = browser(); await b.request();
  for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': 'forged' }, { origin: 'https://evil.test' }, { origin: undefined }, { origin: 'https://evil.test', 'x-forwarded-host': 'evil.test' }]) {
    const r = await b.request('/api/auth/login', { ...post({ email: 'person@example.test', password: 'valid' }), headers });
    assert.equal(r.status, 403);
  }
  assert.equal(b.mock.calls.length, 0);
});

test('login success exposes sanitized user only; wrong password is generic', async () => {
  const b = browser(); await b.request();
  const good = await b.request('/api/auth/login', post({ email: 'person@example.test', password: 'valid' }));
  assert.deepEqual(good.json.data.user, { id: 'user-1', email: 'person@example.test', displayName: 'Test Person' });
  assert.ok(b.jar.has('__Host-coffeenator-refresh')); assert.doesNotMatch(good.text, /access_token|refresh_token|app_metadata/);
  const bad = await b.request('/api/auth/login', post({ email: 'person@example.test', password: 'wrong' }));
  assert.equal(bad.status, 401); assert.doesNotMatch(bad.text, /UPSTREAM_SECRET/);
});

test('signup requires current terms, saves choice, confirmation does not create auth cookies', async () => {
  const b = browser(); await b.request();
  const credentials = { email: 'person@example.test', password: 'valid' };
  for (const input of [credentials, { ...credentials, termsAccepted: false, termsVersion: version }, { ...credentials, ...terms, termsVersion: 'old' }]) {
    assert.equal((await b.request('/api/auth/signup', post(input))).status, 400);
  }
  const r = await b.request('/api/auth/signup', post({ ...credentials, ...terms }));
  assert.deepEqual(r.json.data, { requiresEmailConfirmation: true });
  assert.equal(b.jar.has('__Host-coffeenator-access'), false);
  const call = b.mock.calls.find((c) => c.url.pathname.endsWith('/signup'));
  assert.deepEqual(call.body.data.terms_acceptance, { accepted: true, version });
});

test('Google requires terms and generates identity-only PKCE; mismatched callback fails safely', async () => {
  const b = browser(); await b.request();
  assert.equal((await b.request('/api/auth/google', post())).status, 400);
  const r = await b.request('/api/auth/google', post(terms));
  const url = new URL(r.json.data.redirectUrl);
  assert.equal(url.origin, env.SUPABASE_URL);
  assert.equal(url.searchParams.get('provider'), 'google');
  assert.equal(url.searchParams.get('code_challenge_method'), 's256');
  assert.equal(url.searchParams.get('redirect_to'), `${env.APP_ORIGIN}/auth/callback`);
  assert.doesNotMatch(url.searchParams.get('scopes'), /gmail|drive|calendar/);
  assert.ok(b.jar.has('__Host-coffeenator-pkce'));
  const fail = await b.request('/auth/callback?code=wrong-code&next=https://evil.test');
  assert.equal(fail.headers.location, '/login?error=auth_callback_failed');
  assert.equal(b.jar.has('__Host-coffeenator-pkce'), false);
  const noCookie = await browser().request('/auth/callback?code=valid-code');
  assert.equal(noCookie.headers.location, '/login?error=auth_callback_failed');
});

test('Google callback binds terms to verifier and redirects only to app', async () => {
  const b = browser(); await b.request();
  const google = await b.request('/api/auth/google', post(terms));
  const challenge = new URL(google.json.data.redirectUrl).searchParams.get('code_challenge');
  const r = await b.request('/auth/callback?code=valid-code&next=https://evil.test');
  assert.equal(r.headers.location, '/app');
  const exchange = b.mock.calls.find((c) => c.url.searchParams.get('grant_type') === 'pkce');
  assert.equal(createHash('sha256').update(exchange.body.code_verifier).digest('base64url'), challenge);
  assert.deepEqual(b.mock.calls.find((c) => c.method === 'PUT').body.data.terms_acceptance, { accepted: true, version });
});

test('invalid, reused, and disallowed email confirmation tokens cannot create sessions', async () => {
  const b = browser();
  assert.equal((await b.request('/auth/confirm?token_hash=invalid&type=signup')).headers.location, '/login?error=auth_confirmation_failed');
  assert.equal((await b.request('/auth/confirm?token_hash=valid-token&type=invite')).headers.location, '/login?error=auth_confirmation_failed');
  assert.equal((await b.request('/auth/confirm?token_hash=valid-token&type=email&next=//evil.test')).headers.location, '/app');
  assert.equal((await b.request('/auth/confirm?token_hash=valid-token&type=email')).headers.location, '/login?error=auth_confirmation_failed');
});

test('ordinary session and fake recovery flag cannot reset a password', async () => {
  const b = browser(); b.authenticate(); await b.request(); b.jar.set('__Host-coffeenator-recovery', 'true');
  const r = await b.request('/api/auth/reset-password', post({ password: 'another-password' }));
  assert.equal(r.status, 403); assert.equal(b.mock.calls.some((c) => c.method === 'PUT'), false);
});

test('verified recovery grant is session-bound and consumed after successful reset', async () => {
  const b = browser();
  const confirmation = await b.request('/auth/confirm?token_hash=valid-token&type=recovery');
  assert.equal(confirmation.headers.location, '/reset-password');
  assert.ok(b.jar.has('__Host-coffeenator-recovery'));
  await b.request();
  const r = await b.request('/api/auth/reset-password', post({ password: 'another-password' }));
  assert.equal(r.status, 200); assert.equal(b.jar.has('__Host-coffeenator-recovery'), false);
  assert.equal((await b.request('/api/auth/reset-password', post({ password: 'another-password' }))).status, 403);
  assert.equal((await b.request('/auth/confirm?token_hash=valid-token&type=recovery')).headers.location, '/login?error=auth_confirmation_failed');
});

test('recovery signing config is required in production before token is consumed', async () => {
  const b = browser(backend(), { ...env, AUTH_RECOVERY_SECRET: undefined });
  const r = await b.request('/auth/confirm?token_hash=valid-token&type=recovery');
  assert.equal(r.headers.location, '/login?error=auth_unavailable'); assert.equal(b.mock.calls.length, 0);
});

test('forgot password returns generic success without disclosing identity', async () => {
  const b = browser(); await b.request();
  const r = await b.request('/api/auth/forgot-password', post({ email: 'person@example.test' }));
  assert.equal(r.status, 200); assert.equal(r.json.ok, true); assert.doesNotMatch(r.text, /person@example|access_token|refresh_token/);
});

test('logout revokes current Supabase session and clears every auth cookie', async () => {
  const b = browser(); b.authenticate(); await b.request();
  const r = await b.request('/api/auth/logout', post());
  assert.equal(r.status, 200);
  assert.equal(b.mock.calls.find((c) => c.url.pathname.endsWith('/logout')).url.searchParams.get('scope'), 'local');
  assert.equal(b.jar.size, 0);
});

test('requireAuth rejects anonymous chat, validates authenticated chat before return', async () => {
  const b = browser(); await b.request();
  assert.equal((await b.request('/api/chat', { ...post(), helper: requireAuth })).status, 401);
  b.authenticate();
  const r = await b.request('/api/chat', { ...post(), helper: requireAuth });
  assert.equal(r.returned.id, 'user-1'); assert.equal(r.text, '');
});

test('AI processing consent gates chat and revocation persists', async () => {
  const b = browser(); b.authenticate(); await b.request();
  const denied = await b.request('/api/chat', { ...post(), helper: requireAiConsent });
  assert.equal(denied.status, 403); assert.equal(denied.json.error.code, 'CONSENT_REQUIRED');
  assert.equal((await b.request('/api/auth/consent', post({ accepted: true, version: 'old' }))).status, 400);
  assert.equal((await b.request('/api/auth/consent', post({ accepted: true, version }))).status, 200);
  assert.equal((await b.request()).json.data.aiConsent, true);
  assert.equal((await b.request('/api/chat', { ...post(), helper: requireAiConsent })).returned.id, 'user-1');
  assert.equal((await b.request('/api/auth/consent', post({ accepted: false, version }))).status, 200);
  assert.equal((await b.request()).json.data.aiConsent, false);
  assert.equal((await b.request('/api/chat', { ...post(), helper: requireAiConsent })).status, 403);
});

test('bounded JSON, content type, safe methods and malformed bodies fail before upstream', async () => {
  const b = browser(); await b.request();
  assert.equal((await b.request('/api/auth/login', { ...post('{bad'), parsed: false })).status, 400);
  assert.equal((await b.request('/api/auth/login', post({ password: 'x'.repeat(20_000) }))).status, 413);
  assert.equal((await b.request('/api/auth/login', { ...post(), headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await b.request('/api/auth/session', post())).status, 405);
  assert.equal((await b.request('/api/auth/login')).status, 405);
  assert.equal(b.mock.calls.length, 0);
});

test('upstream outage and missing config are sanitized and do not leak error details', async () => {
  const b = browser({ fetchImpl: async () => { throw new Error('UPSTREAM_SECRET'); } });
  await b.request();
  const r = await b.request('/api/auth/login', post({ email: 'person@example.test', password: 'valid' }));
  assert.equal(r.status, 503); assert.equal(r.json.error.retryable, false); assert.doesNotMatch(r.text, /UPSTREAM_SECRET/);
  assert.equal((await browser(backend(), { ...env, SUPABASE_ANON_KEY: '' }).request()).status, 503);
});

test('unsigned recovery-flow flag cannot promote an OAuth callback into recovery', async () => {
  const b = browser(); await b.request();
  await b.request('/api/auth/google', post(terms));
  const verifier = decodeURIComponent(b.jar.get('__Host-coffeenator-pkce'));
  const forged = { kind: 'recovery', purpose: 'recovery-flow', verifierHash: createHash('sha256').update(verifier).digest('base64url'), version };
  b.jar.set('__Host-coffeenator-flow', Buffer.from(JSON.stringify(forged)).toString('base64url'));
  const r = await b.request('/auth/callback?code=valid-code');
  assert.equal(r.headers.location, '/login?error=auth_callback_failed');
  assert.equal(b.mock.calls.length, 0);
});

test('logout clears local cookies even when remote revocation cannot be completed', async () => {
  const mock = backend();
  const b = browser(mock); b.authenticate(); await b.request();
  mock.fetchImpl = async () => { throw new Error('UPSTREAM_SECRET'); };
  const r = await b.request('/api/auth/logout', post());
  assert.equal(r.status, 503); assert.equal(b.jar.size, 0); assert.doesNotMatch(r.text, /UPSTREAM_SECRET/);
});

test('replaying a previously valid recovery grant after password change is rejected', async () => {
  const b = browser();
  await b.request('/auth/confirm?token_hash=valid-token&type=recovery');
  const grant = b.jar.get('__Host-coffeenator-recovery');
  await b.request();
  assert.equal((await b.request('/api/auth/reset-password', post({ password: 'changed' }))).status, 200);
  b.jar.set('__Host-coffeenator-recovery', grant);
  assert.equal((await b.request('/api/auth/reset-password', post({ password: 'changed-again' }))).status, 403);
});

test('a valid recovery grant cannot be applied to another authenticated session', async () => {
  const b = browser();
  await b.request('/auth/confirm?token_hash=valid-token&type=recovery');
  const grant = b.jar.get('__Host-coffeenator-recovery');
  const mock = backend();
  const upstream = mock.fetchImpl;
  mock.fetchImpl = async (input, init) => {
    if (new URL(input).pathname.endsWith('/user') && init.method === 'GET') return ok(baseUser);
    return upstream(input, init);
  };
  const other = browser(mock); other.authenticate();
  other.jar.set('__Host-coffeenator-access', jwt(false, 'other-session'));
  other.jar.set('__Host-coffeenator-recovery', grant);
  await other.request();
  assert.equal((await other.request('/api/auth/reset-password', post({ password: 'changed' }))).status, 403);
  assert.equal(mock.calls.length, 0);
});

test('signed PKCE password recovery redirects to reset and does not trust URL type flags', async () => {
  const b = browser(); await b.request();
  await b.request('/api/auth/forgot-password', post({ email: 'person@example.test' }));
  assert.equal((await b.request('/auth/callback?code=recovery-code&type=signup')).headers.location, '/reset-password');
  assert.ok(b.jar.has('__Host-coffeenator-recovery'));
  const google = browser(); await google.request(); await google.request('/api/auth/google', post(terms));
  assert.equal((await google.request('/auth/callback?code=valid-code&type=recovery')).headers.location, '/app');
  assert.equal(google.jar.has('__Host-coffeenator-recovery'), false);
});

test('signed recovery start still rejects non-email-authenticated code or a different email', async () => {
  const b = browser(); await b.request();
  await b.request('/api/auth/forgot-password', post({ email: 'person@example.test' }));
  assert.equal((await b.request('/auth/callback?code=valid-code')).headers.location, '/login?error=auth_callback_failed');
  const other = browser(); await other.request();
  await other.request('/api/auth/forgot-password', post({ email: 'different@example.test' }));
  assert.equal((await other.request('/auth/callback?code=recovery-code')).headers.location, '/login?error=auth_callback_failed');
});

test('callback aliases retain method allowlists and safely redirect on missing configuration', async () => {
  const b = browser();
  assert.equal((await b.request('/auth/callback', post())).status, 405);
  assert.equal((await b.request('/api/auth/confirm', post())).status, 405);
  const missing = browser(backend(), { ...env, SUPABASE_ANON_KEY: '' });
  assert.equal((await missing.request('/auth/callback?code=valid-code')).headers.location, '/login?error=auth_unavailable');
});

test('auto-confirmed signup verifies returned session and stores no identity JSON cookie', async () => {
  const mock = backend(); const upstream = mock.fetchImpl;
  mock.fetchImpl = async (input, init) => new URL(input).pathname.endsWith('/signup') ? ok(session()) : upstream(input, init);
  const b = browser(mock); await b.request();
  const r = await b.request('/api/auth/signup', post({ email: 'person@example.test', password: 'valid', ...terms }));
  assert.equal(r.json.data.user.id, 'user-1'); assert.ok(b.jar.has('__Host-coffeenator-access'));
  assert.doesNotMatch(r.text, /access_token|refresh_token/);
});

test('HTTP loopback development cookies omit Secure but retain HttpOnly and strict origin', async () => {
  const b = browser(backend(), { ...env, APP_ORIGIN: 'http://localhost:4173', NODE_ENV: 'development' });
  const r = await b.request();
  assert.ok(b.jar.has('coffeenator-csrf')); assert.doesNotMatch(r.headers['set-cookie'][0], /Secure/); assert.match(r.headers['set-cookie'][0], /HttpOnly/);
  assert.equal((await b.request('/api/auth/login', { ...post({ email: 'person@example.test', password: 'valid' }), headers: { origin: 'http://localhost:4174' } })).status, 403);
});

test('old or string-valued metadata never grants AI consent; anonymous consent is rejected', async () => {
  const b = browser(); await b.request();
  assert.equal((await b.request('/api/auth/consent', post({ accepted: true, version }))).status, 401);
  b.authenticate();
  for (const choice of [{ accepted: true, version: 'old' }, { accepted: 'true', version }]) {
    b.mock.setUser({ ...baseUser, user_metadata: { ai_processing_consent: choice } });
    assert.equal((await b.request()).json.data.aiConsent, false);
    assert.equal((await b.request('/api/chat', { ...post(), helper: requireAiConsent })).status, 403);
  }
});

test('warm-instance auth attempt limiter blocks repeated attempts without invoking upstream', async () => {
  const b = browser(); await b.request();
  let r;
  for (let i = 0; i < 21; i++) r = await b.request('/api/auth/login', post({ email: 'person@example.test', password: 'wrong' }));
  assert.equal(r.status, 429); assert.ok(Number(r.headers['retry-after']) > 0);
  assert.ok(b.mock.calls.length <= 20);
});
