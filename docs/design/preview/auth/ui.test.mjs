import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { AuthError, TERMS_VERSION, createAuthClient, createAuthPayload, getAuthMode, getCallbackFeedback, getSignupOutcome, safeGoogleRedirect, shouldRedirectToApp, togglePasswordVisibility } from './app.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const session = (csrfToken = 'test-csrf') => json({ ok: true, data: { user: null, csrfToken, aiConsent: false } });

test('one page resolves all four account paths, including trailing slashes', () => {
  for (const mode of ['login', 'signup', 'forgot-password', 'reset-password']) {
    assert.equal(getAuthMode(`/${mode}`), mode);
    assert.equal(getAuthMode(`/${mode}/`), mode);
  }
  assert.equal(getAuthMode('/__proto__'), 'login');
  assert.equal(getAuthMode('/unknown'), 'login');
});

test('authenticated users redirect only from login and signup, never recovery', () => {
  const user = { id: 'one', email: 'person@example.com' };
  assert.equal(shouldRedirectToApp('login', user), true);
  assert.equal(shouldRedirectToApp('signup', user), true);
  assert.equal(shouldRedirectToApp('reset-password', user), false);
  assert.equal(shouldRedirectToApp('forgot-password', user), false);
  assert.equal(shouldRedirectToApp('login', null), false);
  assert.equal(getSignupOutcome({ requiresEmailConfirmation: true }), 'confirmation');
  assert.equal(getSignupOutcome({ requiresEmailConfirmation: false }), 'app');
  assert.equal(getSignupOutcome({ user }), 'app');
  assert.equal(getSignupOutcome({ user: {} }), null);
  assert.equal(getSignupOutcome({}), null);
});

test('callback feedback only maps fixed safe values including completed backend codes', () => {
  assert.match(getCallbackFeedback('?error=access_denied').message, /cancelled/);
  assert.match(getCallbackFeedback('?auth_error=recovery_expired').message, /reset link has expired/);
  assert.match(getCallbackFeedback('?error_code=otp_expired').message, /expired/);
  assert.match(getCallbackFeedback('?error=auth_callback_failed').message, /complete sign-in/);
  assert.match(getCallbackFeedback('?error=auth_confirmation_failed').message, /verify this email/);
  assert.match(getCallbackFeedback('?error=auth_unavailable').message, /temporarily unavailable/);
  assert.equal(getCallbackFeedback('?error=AUTH_CALLBACK_FAILED').message, getCallbackFeedback('?error=auth_callback_failed').message);
  assert.equal(getCallbackFeedback('?notice=email_confirmed').kind, 'notice');
  assert.equal(getCallbackFeedback('?email=person@example.com&error_description=untrusted'), null);
  for (const code of ['<img src=x onerror=alert(1)>', '__proto__', 'constructor', 'upstream-secret']) {
    const feedback = getCallbackFeedback(`?error=${encodeURIComponent(code)}&error_description=upstream-secret`);
    assert.equal(feedback.kind, 'error');
    assert.equal(feedback.message.includes(code), false);
    assert.equal(feedback.message.includes('upstream-secret'), false);
  }
});

test('Google redirects require HTTPS hosted Supabase authorization and Google provider', () => {
  const good = 'https://demo-project.supabase.co/auth/v1/authorize?provider=google&redirect_to=https%3A%2F%2Fapp.example%2Fapi%2Fauth%2Fcallback';
  assert.equal(safeGoogleRedirect(good), good);
  for (const bad of [
    'javascript:alert(1)', '//demo.supabase.co/auth/v1/authorize?provider=google',
    'http://demo.supabase.co/auth/v1/authorize?provider=google',
    'https://demo.supabase.co.attacker.test/auth/v1/authorize?provider=google',
    'https://supabase.co/auth/v1/authorize?provider=google',
    'https://user:password@demo.supabase.co/auth/v1/authorize?provider=google',
    'https://demo.supabase.co:8443/auth/v1/authorize?provider=google',
    'https://demo.supabase.co/auth/v1/authorize?provider=github',
    'https://demo.supabase.co/auth/v1/authorize?provider=google#fragment',
    'https://demo.supabase.co/other?provider=google', null, {},
  ]) assert.equal(safeGoogleRedirect(bad), null);
});

test('terms and privacy acknowledgment are mandatory for email signup and Google', () => {
  assert.equal(TERMS_VERSION, '2026-09-19');
  for (const mode of ['signup', 'google']) {
    for (const termsAccepted of [undefined, false, 'true']) assert.throws(() => createAuthPayload(mode, { termsAccepted }), { code: 'terms_required' });
  }
  assert.deepEqual(createAuthPayload('google', { termsAccepted: true }), { termsAccepted: true, termsVersion: TERMS_VERSION });
  assert.deepEqual(createAuthPayload('signup', { email: ' person@example.com ', password: ' x ', termsAccepted: true }), {
    email: 'person@example.com', password: ' x ', termsAccepted: true, termsVersion: TERMS_VERSION,
  });
});

test('payloads preserve passwords and do not invent a password policy or AI consent', () => {
  assert.deepEqual(createAuthPayload('login', { email: ' person@example.com ', password: ' a ' }), { email: 'person@example.com', password: ' a ' });
  assert.deepEqual(createAuthPayload('reset-password', { password: 'a' }), { password: 'a' });
  assert.deepEqual(createAuthPayload('forgot-password', { email: ' person@example.com ', password: 'not-sent' }), { email: 'person@example.com' });
  assert.throws(() => createAuthPayload('logout'), { code: 'invalid_action' });
});

test('every POST uses the session CSRF token, same-origin credentials, and no caching', async () => {
  const requests = [];
  const client = createAuthClient(async (url, init) => {
    requests.push({ url, init });
    return url.endsWith('/session') ? session() : json({ ok: true, data: {} });
  });
  const initial = await client.session();
  assert.equal(initial.aiConsent, false);
  for (const action of ['login', 'signup', 'google', 'forgot-password', 'reset-password']) await client.post(action, { field: 'test' });
  assert.equal(requests.length, 6);
  for (const { init } of requests) {
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal);
  }
  for (const { url, init } of requests.slice(1)) {
    assert.match(url, /^\/api\/auth\//);
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['X-CSRF-Token'], 'test-csrf');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), { field: 'test' });
  }
});

test('POST never runs before session initialization or for an unrecognized path', async () => {
  let requests = 0;
  const client = createAuthClient(async () => { requests += 1; return session(); });
  await assert.rejects(client.post('login', {}), { code: 'session_required' });
  await assert.rejects(client.post('../../external', {}), { code: 'invalid_action' });
  assert.equal(requests, 0);
});

test('malformed sessions cannot enable mutation requests', async () => {
  for (const data of [{ user: null }, { user: null, csrfToken: '' }, { user: {}, csrfToken: 'token' }, { csrfToken: 'token' }]) {
    const client = createAuthClient(async () => json({ ok: true, data }));
    await assert.rejects(client.session(), { code: 'invalid_response' });
    await assert.rejects(client.post('login', {}), { code: 'session_required' });
  }
});

test('reconnecting rotates the in-memory CSRF token', async () => {
  let token = 'first';
  const received = [];
  const client = createAuthClient(async (url, init) => {
    if (url.endsWith('/session')) return session(token);
    received.push(init.headers['X-CSRF-Token']);
    return json({ ok: true, data: {} });
  });
  await client.session();
  await client.post('login', {});
  token = 'second';
  await client.session();
  await client.post('login', {});
  assert.deepEqual(received, ['first', 'second']);
});

test('failed reconnect invalidates an old CSRF token', async () => {
  let fail = false;
  const client = createAuthClient(async () => fail ? Promise.reject(new Error('private upstream detail')) : session());
  await client.session();
  fail = true;
  await assert.rejects(client.session(), { code: 'network_error' });
  await assert.rejects(client.post('login', {}), { code: 'session_required' });
});

test('server errors retain authoritative sanitized messages and retryability', async () => {
  const client = createAuthClient(async () => json({ ok: false, error: { code: 'WEAK_PASSWORD', message: 'Choose a longer password.', retryable: false } }, 400));
  await assert.rejects(client.session(), (error) => error instanceof AuthError && error.code === 'WEAK_PASSWORD' && error.message === 'Choose a longer password.' && error.retryable === false);
});

test('network, malformed JSON, and malformed success responses never become success', async () => {
  const clients = [
    [createAuthClient(async () => { throw new Error('secret connection string'); }), 'network_error'],
    [createAuthClient(async () => new Response('<upstream-error>', { status: 502 })), 'invalid_response'],
    [createAuthClient(async () => json({ ok: true })), 'invalid_response'],
    [createAuthClient(async () => json({ ok: true, data: [] })), 'invalid_response'],
  ];
  for (const [client, code] of clients) await assert.rejects(client.session(), (error) => error.code === code && !error.message.includes('secret') && !error.message.includes('upstream-error'));
});

test('requests time out with a safe retryable error', async () => {
  const client = createAuthClient((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('internal timeout')), { once: true })), 5);
  await assert.rejects(client.session(), (error) => error.code === 'timeout' && error.retryable === true && !error.message.includes('internal'));
});

test('password visibility preserves selection and focused input, with accessible toggle state', () => {
  const attributes = {};
  const selectionCalls = [];
  let focused = 0;
  const input = { type: 'password', selectionStart: 2, selectionEnd: 5, selectionDirection: 'backward', focus() { focused += 1; }, setSelectionRange(...args) { selectionCalls.push(args); } };
  input.ownerDocument = { activeElement: input };
  const button = { setAttribute(name, value) { attributes[name] = value; } };
  assert.equal(togglePasswordVisibility(input, button), true);
  assert.equal(input.type, 'text');
  assert.equal(attributes['aria-label'], 'Hide password');
  assert.equal(attributes['aria-pressed'], 'true');
  assert.equal(focused, 1);
  assert.deepEqual(selectionCalls, [[2, 5, 'backward']]);
  input.ownerDocument.activeElement = button;
  assert.equal(togglePasswordVisibility(input, button), false);
  assert.equal(attributes['aria-label'], 'Show password');
  assert.equal(attributes['aria-pressed'], 'false');
  assert.equal(focused, 1);
});

test('static UI keeps legal notices, local assets, accessible controls, and reduced motion', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('./app.mjs', import.meta.url), 'utf8');
  for (const href of ['/terms', '/privacy', '/ai-data', '/cookies', '/legal']) assert.ok(html.includes(`href="${href}"`));
  assert.match(html, /Demo · fictional company details/);
  assert.match(html, /id="terms-accepted"[^>]*type="checkbox"/);
  assert.doesNotMatch(html, /id="terms-accepted"[^>]*\bchecked\b/);
  assert.match(html, /aria-label="Show password" aria-pressed="false"/);
  assert.match(html, /autocomplete="email"/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(js, /'new-password'/);
  assert.doesNotMatch(html, /(?:src|href)="https?:/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|innerHTML|insertAdjacentHTML/);
  assert.doesNotMatch(html, /minlength=|pattern=/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.password-toggle[^}]*min-width: 44px[^}]*height: 44px/);
});
