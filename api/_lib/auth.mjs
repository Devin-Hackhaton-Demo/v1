import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const VERSION = '2026-09-19';
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_AGE = 30 * 24 * 60 * 60;
const FLOW_AGE = 15 * 60;
const COOKIE_PARTS = ['access', 'refresh', 'csrf', 'pkce', 'flow', 'recovery'];
const STORAGE_KEY = 'coffeenator-auth';
const attempts = new Map();
const requestContexts = new WeakMap();
const developmentKey = randomBytes(32);

class AuthFailure extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const unavailable = () => new AuthFailure(503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable. Please try again.');
const invalidInput = () => new AuthFailure(400, 'VALIDATION_ERROR', 'Please check the submitted information.');
const denied = () => new AuthFailure(403, 'CSRF_INVALID', 'This request could not be verified. Reload the page and try again.');
const hash = (value) => createHash('sha256').update(value).digest('base64url');
function equal(left, right) {
  return typeof left === 'string' && typeof right === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}
function header(request, name) {
  const value = request.headers?.[name];
  return typeof value === 'string' ? value : '';
}
function config(env) {
  try {
    const origin = new URL(env.APP_ORIGIN);
    const url = new URL(env.SUPABASE_URL);
    const local = (value) => ['localhost', '127.0.0.1', '[::1]'].includes(value.hostname);
    if (origin.origin !== env.APP_ORIGIN || origin.username || origin.password || !['http:', 'https:'].includes(origin.protocol) || (origin.protocol !== 'https:' && !local(origin))) throw unavailable();
    if (url.username || url.password || url.search || url.hash || !['http:', 'https:'].includes(url.protocol) || (url.protocol !== 'https:' && !local(url))) throw unavailable();
    if (typeof env.SUPABASE_ANON_KEY !== 'string' || !env.SUPABASE_ANON_KEY.trim() || env.SUPABASE_ANON_KEY.startsWith('sb_secret_')) throw unavailable();
    try {
      const payload = JSON.parse(Buffer.from(env.SUPABASE_ANON_KEY.split('.')[1] || '', 'base64url').toString());
      if (payload.role === 'service_role') throw unavailable();
    } catch (error) { if (error instanceof AuthFailure) throw error; }
    return { origin: origin.origin, url: url.href.replace(/\/$/, ''), key: env.SUPABASE_ANON_KEY, secure: origin.protocol === 'https:', env, local: local(origin) };
  } catch { throw unavailable(); }
}
function recoveryKey(cfg) {
  const value = cfg.env.AUTH_RECOVERY_SECRET;
  if (typeof value === 'string' && Buffer.byteLength(value) >= 32) return value;
  if (cfg.local && ['development', 'test'].includes(cfg.env.NODE_ENV)) return developmentKey;
  throw unavailable();
}
function securityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Vary', 'Cookie, Origin');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}
function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}
function errorResponse(response, error) {
  const safe = error instanceof AuthFailure ? error : unavailable();
  json(response, safe.status, { ok: false, error: { code: safe.code, message: safe.message, retryable: false } });
}
function success(response, data) { json(response, 200, { ok: true, data }); }
function redirect(response, location) {
  response.writeHead(303, { Location: location });
  response.end();
}
function cookieJar(request, response, cfg) {
  const prefix = cfg.secure ? '__Host-coffeenator-' : 'coffeenator-';
  const incoming = new Map();
  const duplicates = new Set();
  const outgoing = new Map();
  const cookieHeader = header(request, 'cookie');
  if (cookieHeader.length <= 32 * 1024) {
    for (const item of cookieHeader.split(';')) {
      const index = item.indexOf('=');
      if (index < 0) continue;
      const name = item.slice(0, index).trim();
      if (!COOKIE_PARTS.some((part) => name === prefix + part)) continue;
      if (incoming.has(name)) duplicates.add(name);
      try { incoming.set(name, decodeURIComponent(item.slice(index + 1).trim())); } catch { duplicates.add(name); }
    }
  }
  for (const name of duplicates) incoming.delete(name);
  function set(part, value, age = SESSION_AGE) {
    if (Buffer.byteLength(encodeURIComponent(value)) > 3800) throw unavailable();
    const name = prefix + part;
    if (age === 0) incoming.delete(name); else incoming.set(name, value);
    outgoing.set(name, `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${cfg.secure ? '; Secure' : ''}`);
    response.setHeader('Set-Cookie', [...outgoing.values()]);
  }
  return {
    get: (part) => incoming.get(prefix + part), set,
    clear: (part) => set(part, '', 0),
    clearSession() { for (const part of ['access', 'refresh', 'recovery']) set(part, '', 0); },
    clearAll() { for (const part of COOKIE_PARTS) set(part, '', 0); },
  };
}
function csrf(context) {
  let token = context.cookies.get('csrf');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    token = randomBytes(32).toString('base64url');
    context.cookies.set('csrf', token);
  }
  return token;
}
function validateMutation(request, context) {
  if (['GET', 'HEAD'].includes(request.method)) return;
  if (header(request, 'origin') !== context.cfg.origin) throw denied();
  const cookie = context.cookies.get('csrf');
  const token = header(request, 'x-csrf-token');
  if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie) || !equal(cookie, token)) throw denied();
  if (header(request, 'sec-fetch-site') === 'cross-site') throw denied();
}
function checkRate(request, response, cfg, action) {
  const now = Date.now();
  for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
  const identity = request.socket?.remoteAddress || 'unknown';
  const key = hash(`${cfg.origin}:${identity}:${action === 'session' ? 'session' : 'attempt'}`);
  let record = attempts.get(key);
  if (!record) {
    if (attempts.size >= 5000) {
      response.setHeader('Retry-After', '60');
      throw new AuthFailure(429, 'RATE_LIMITED', 'Too many authentication attempts. Please wait and try again.');
    }
    record = { count: 0, until: now + 60_000 };
    attempts.set(key, record);
  }
  record.count += 1;
  if (record.count > (action === 'session' ? 120 : 20)) {
    response.setHeader('Retry-After', String(Math.max(1, Math.ceil((record.until - now) / 1000))));
    throw new AuthFailure(429, 'RATE_LIMITED', 'Too many authentication attempts. Please wait and try again.');
  }
}
function sdk(context, fetchImpl) {
  const memory = new Map();
  const verifierKey = `${STORAGE_KEY}-code-verifier`;
  const stored = context.cookies.get('pkce');
  if (stored) memory.set(verifierKey, stored);
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem(key, value) {
      memory.set(key, value);
      if (key === verifierKey) context.cookies.set('pkce', value, FLOW_AGE);
    },
    removeItem(key) {
      memory.delete(key);
      if (key === verifierKey) context.cookies.clear('pkce');
    },
  };
  const safeFetch = async (input, init = {}) => {
    try {
      const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
      const result = await fetchImpl(input, { ...init, signal, redirect: 'error' });
      if (result.status < 500 && result.status !== 429) return result;
      await result.body?.cancel();
    } catch {}
    return new Response(JSON.stringify({ error_code: 'auth_upstream_unavailable', message: 'Authentication unavailable' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  };
  return createClient(context.cfg.url, context.cfg.key, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage, storageKey: STORAGE_KEY },
    global: { fetch: safeFetch },
  });
}
function makeContext(request, response, { env = process.env, fetchImpl = globalThis.fetch, authorizeUser } = {}) {
  const cfg = config(env);
  const context = { cfg, cookies: cookieJar(request, response, cfg), user: null, rawUser: null, access: null, refresh: null, authorizeUser };
  context.client = sdk(context, fetchImpl);
  requestContexts.set(request, context);
  return context;
}
function upstream(error, fallbackStatus = 400) {
  if (!error) return;
  if (error.code === 'auth_upstream_unavailable' || error.status >= 500 || error.name === 'AuthRetryableFetchError') throw unavailable();
  if (error.code === 'weak_password') throw new AuthFailure(400, 'WEAK_PASSWORD', 'Choose a stronger password that meets the password policy.');
  throw new AuthFailure(fallbackStatus, fallbackStatus === 401 ? 'AUTH_FAILED' : 'AUTH_REQUEST_FAILED', 'Authentication could not be completed. Check your information and try again.');
}
function publicUser(user) {
  if (!user || typeof user.id !== 'string' || typeof user.email !== 'string' || !user.id || !user.email) return null;
  const result = { id: user.id, email: user.email };
  const name = user.user_metadata?.display_name ?? user.user_metadata?.full_name ?? user.user_metadata?.name;
  if (typeof name === 'string' && name.trim()) result.displayName = name.slice(0, 160);
  return result;
}
function hasAiConsent(user) {
  const choice = user?.user_metadata?.ai_processing_consent;
  return choice?.accepted === true && choice?.version === VERSION;
}
async function verifyUser(context, access) {
  const { data, error } = await context.client.auth.getUser(access);
  if (error?.code === 'auth_upstream_unavailable' || error?.status >= 500) throw unavailable();
  const user = error ? null : data.user;
  if (user && context.authorizeUser && !context.authorizeUser(publicUser(user))) return null;
  return user;
}
function setSessionCookies(context, session, user) {
  if (!session || typeof session.access_token !== 'string' || typeof session.refresh_token !== 'string' || !session.access_token || !session.refresh_token || !publicUser(user)) throw unavailable();
  if ([session.access_token, session.refresh_token].some((value) => Buffer.byteLength(encodeURIComponent(value)) > 3800)) throw unavailable();
  context.cookies.set('access', session.access_token);
  context.cookies.set('refresh', session.refresh_token);
  context.access = session.access_token;
  context.refresh = session.refresh_token;
  context.rawUser = user;
  context.user = publicUser(user);
}
async function acceptSession(context, session) {
  if (!session?.access_token || !session?.refresh_token) throw unavailable();
  const user = await verifyUser(context, session.access_token);
  if (!user) { context.cookies.clearSession(); throw new AuthFailure(401, 'AUTH_FAILED', 'Authentication could not be verified.'); }
  setSessionCookies(context, session, user);
  return context.user;
}
async function authenticate(context) {
  const access = context.cookies.get('access');
  const refresh = context.cookies.get('refresh');
  if (!access && !refresh) return;
  let user = access ? await verifyUser(context, access) : null;
  if (user && refresh) {
    context.access = access;
    context.refresh = refresh;
    context.rawUser = user;
    context.user = publicUser(user);
    if (!context.user) context.cookies.clearSession();
    return;
  }
  if (refresh) {
    const { data, error } = await context.client.auth.refreshSession({ refresh_token: refresh });
    if (error?.code === 'auth_upstream_unavailable' || error?.status >= 500) throw unavailable();
    if (!error && data.session) {
      user = await verifyUser(context, data.session.access_token);
      if (publicUser(user)) { setSessionCookies(context, data.session, user); return; }
    }
  }
  context.cookies.clearSession();
}
async function loadSdkSession(context) {
  const { data, error } = await context.client.auth.setSession({ access_token: context.access, refresh_token: context.refresh });
  upstream(error, 401);
  if (data.session && data.session.access_token !== context.access) await acceptSession(context, data.session);
}
async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(header(request, 'content-type'))) throw new AuthFailure(415, 'UNSUPPORTED_MEDIA_TYPE', 'Use an application/json request body.');
  const length = header(request, 'content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) throw new AuthFailure(413, 'BODY_TOO_LARGE', 'The request body is too large.');
  let body = request.body;
  try {
    if (body === undefined) {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) throw new AuthFailure(413, 'BODY_TOO_LARGE', 'The request body is too large.');
        chunks.push(bytes);
      }
      body = Buffer.concat(chunks).toString('utf8');
    }
    if (Buffer.isBuffer(body)) body = body.toString('utf8');
    if (typeof body === 'string') {
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new AuthFailure(413, 'BODY_TOO_LARGE', 'The request body is too large.');
      body = JSON.parse(body);
    } else if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES) throw new AuthFailure(413, 'BODY_TOO_LARGE', 'The request body is too large.');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidInput();
    return body;
  } catch (error) { if (error instanceof AuthFailure) throw error; throw invalidInput(); }
}
function email(value) {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw invalidInput();
  return value.trim();
}
function password(value) { if (typeof value !== 'string' || !value.length) throw invalidInput(); return value; }
function requireTerms(body) {
  if (body.termsAccepted !== true || body.termsVersion !== VERSION) throw new AuthFailure(400, 'TERMS_REQUIRED', 'Accept the current demo terms to continue.');
}
function sign(context, purpose, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, purpose, expires: Math.floor(Date.now() / 1000) + FLOW_AGE })).toString('base64url');
  const signature = createHmac('sha256', recoveryKey(context.cfg)).update(`${context.cfg.origin}|${context.cfg.url}|${body}`).digest('base64url');
  return `${body}.${signature}`;
}
function unseal(context, value, purpose) {
  if (typeof value !== 'string' || value.length > 3800) return null;
  try {
    const [body, signature, extra] = value.split('.');
    if (extra || !body || !signature) return null;
    const expected = createHmac('sha256', recoveryKey(context.cfg)).update(`${context.cfg.origin}|${context.cfg.url}|${body}`).digest('base64url');
    if (!equal(expected, signature)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    return data.purpose === purpose && data.expires > now && data.expires <= now + FLOW_AGE ? data : null;
  } catch (error) { if (error instanceof AuthFailure) throw error; return null; }
}
function verifiedClaims(context) {
  try {
    const claims = JSON.parse(Buffer.from(context.access.split('.')[1], 'base64url').toString());
    return claims.sub === context.user.id ? claims : null;
  } catch { return null; }
}
function verifiedSessionId(context) {
  const claims = verifiedClaims(context);
  return typeof claims?.session_id === 'string' && claims.session_id ? claims.session_id : null;
}
function validateRecoveryExchange(context, flow) {
  const methods = verifiedClaims(context)?.amr;
  const emailAuthenticated = Array.isArray(methods) && methods.some((entry) => ['otp', 'recovery'].includes(typeof entry === 'string' ? entry : entry?.method));
  if (!emailAuthenticated || flow.emailHash !== hash(context.user.email.toLowerCase())) throw invalidInput();
}
function recoveryGrant(context) {
  const sessionId = verifiedSessionId(context);
  const revision = context.rawUser?.updated_at;
  if (!sessionId || typeof revision !== 'string' || !revision) throw unavailable();
  context.cookies.set('recovery', sign(context, 'reset-password', { sessionId, userId: context.user.id, revision }), FLOW_AGE);
}
function validateRecovery(context) {
  const grant = unseal(context, context.cookies.get('recovery'), 'reset-password');
  if (!grant || grant.userId !== context.user.id || grant.sessionId !== verifiedSessionId(context) || grant.revision !== context.rawUser?.updated_at) {
    context.cookies.clear('recovery');
    throw new AuthFailure(403, 'RECOVERY_REQUIRED', 'Open a valid password recovery link before changing your password.');
  }
}
function saveFlow(context, kind, address) {
  const verifier = context.cookies.get('pkce');
  if (!verifier) throw unavailable();
  const payload = { kind, verifierHash: hash(verifier), version: VERSION, ...(address ? { emailHash: hash(address.toLowerCase()) } : {}) };
  const value = kind === 'recovery' ? sign(context, 'recovery-flow', payload) : Buffer.from(JSON.stringify(payload)).toString('base64url');
  context.cookies.set('flow', value, FLOW_AGE);
}
function readFlow(context) {
  const value = context.cookies.get('flow');
  if (!value || !context.cookies.get('pkce')) return null;
  let flow;
  const signed = value.includes('.');
  try {
    flow = signed ? unseal(context, value, 'recovery-flow') : JSON.parse(Buffer.from(value, 'base64url').toString());
  } catch (error) { if (error instanceof AuthFailure) throw error; return null; }
  if (!flow || !['google', 'signup', 'recovery'].includes(flow.kind) || flow.version !== VERSION || flow.verifierHash !== hash(context.cookies.get('pkce')) || (flow.kind === 'recovery' && (!signed || flow.purpose !== 'recovery-flow'))) return null;
  return flow;
}
async function callback(request, response, context, url, action) {
  const failure = action === 'confirm' ? 'auth_confirmation_failed' : 'auth_callback_failed';
  try {
    let recovery = false;
    let google = false;
    let recoveryFlow;
    let result;
    if (url.searchParams.has('error')) throw invalidInput();
    if (action === 'confirm') {
      const type = url.searchParams.get('type');
      const tokenHash = url.searchParams.get('token_hash');
      if (!['email', 'signup', 'recovery'].includes(type) || !tokenHash || tokenHash.length > 2048 || url.searchParams.getAll('token_hash').length !== 1 || url.searchParams.getAll('type').length !== 1) throw invalidInput();
      recovery = type === 'recovery';
      if (recovery) recoveryKey(context.cfg);
      result = await context.client.auth.verifyOtp({ type, token_hash: tokenHash });
    } else {
      const code = url.searchParams.get('code');
      const flow = readFlow(context);
      if (!code || code.length > 2048 || url.searchParams.getAll('code').length !== 1 || !flow) throw invalidInput();
      recovery = flow.kind === 'recovery';
      recoveryFlow = recovery ? flow : null;
      google = flow.kind === 'google';
      result = await context.client.auth.exchangeCodeForSession(code);
    }
    upstream(result.error);
    await acceptSession(context, result.data.session);
    if (recoveryFlow) validateRecoveryExchange(context, recoveryFlow);
    context.cookies.clear('recovery');
    if (google) {
      const { error } = await context.client.auth.updateUser({ data: { terms_acceptance: { accepted: true, version: VERSION } } });
      upstream(error);
    }
    if (recovery) recoveryGrant(context);
    context.cookies.clear('pkce');
    context.cookies.clear('flow');
    context.cookies.set('csrf', randomBytes(32).toString('base64url'));
    redirect(response, recovery ? '/reset-password' : '/app');
  } catch (error) {
    context.cookies.clearSession();
    context.cookies.clear('pkce');
    context.cookies.clear('flow');
    redirect(response, `/login?error=${error instanceof AuthFailure && error.status === 503 ? 'auth_unavailable' : failure}`);
  }
}
export async function getAuthContext(request, response, options = {}) {
  securityHeaders(response);
  const context = makeContext(request, response, options);
  await authenticate(context);
  return { user: context.user, csrfToken: csrf(context) };
}
export function getVerifiedSession(request) {
  const context = requestContexts.get(request);
  return context?.user && context.access ? { user: context.user, accessToken: context.access } : null;
}
export async function requireAuth(request, response, options = {}) {
  securityHeaders(response);
  try {
    const context = makeContext(request, response, options);
    if (options.rejectAnonymousFirst && !context.cookies.get('access') && !context.cookies.get('refresh')) throw new AuthFailure(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    validateMutation(request, context);
    await authenticate(context);
    if (!context.user) throw new AuthFailure(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    return context.user;
  } catch (error) { errorResponse(response, error); return null; }
}
export async function requireAiConsent(request, response, options = {}) {
  const user = await requireAuth(request, response, options);
  if (!user) return null;
  if (!hasAiConsent(requestContexts.get(request)?.rawUser)) {
    errorResponse(response, new AuthFailure(403, 'CONSENT_REQUIRED', 'Choose whether to allow AI processing before sending a message.'));
    return null;
  }
  return user;
}
export async function handleAuthRequest(request, response, options = {}) {
  securityHeaders(response);
  let context;
  let action = typeof request.url === 'string' ? /^\/(?:api\/)?auth\/(callback|confirm)(?:\?|$)/.exec(request.url)?.[1] : undefined;
  try {
    context = makeContext(request, response, options);
    if (typeof request.url !== 'string' || request.url.length > 8192 || !request.url.startsWith('/') || request.url.startsWith('//')) throw invalidInput();
    const url = new URL(request.url, context.cfg.origin);
    const match = /^\/api\/auth\/([a-z-]+)$/.exec(url.pathname) || /^\/auth\/(callback|confirm)$/.exec(url.pathname);
    action = match?.[1];
    const allowed = ['session', 'callback', 'confirm'].includes(action) ? 'GET' : ['login', 'signup', 'google', 'forgot-password', 'reset-password', 'logout', 'consent'].includes(action) ? 'POST' : null;
    if (!allowed) throw new AuthFailure(404, 'NOT_FOUND', 'This authentication endpoint does not exist.');
    if (request.method !== allowed) {
      response.setHeader('Allow', allowed);
      throw new AuthFailure(405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
    }
    validateMutation(request, context);
    checkRate(request, response, context.cfg, action);
    if (action === 'callback' || action === 'confirm') return await callback(request, response, context, url, action);
    if (action === 'session') {
      await authenticate(context);
      return success(response, { user: context.user, csrfToken: csrf(context), aiConsent: hasAiConsent(context.rawUser) });
    }
    const body = await readBody(request);
    if (action === 'login' || action === 'signup') {
      const credentials = { email: email(body.email), password: password(body.password) };
      if (action === 'login' && options.validateLogin && !options.validateLogin(credentials)) throw new AuthFailure(401, 'AUTH_FAILED', 'Invalid email or password.');
      if (action === 'signup') {
        requireTerms(body);
        credentials.options = { emailRedirectTo: `${context.cfg.origin}/auth/callback`, data: { terms_acceptance: { accepted: true, version: VERSION } } };
      }
      const { data, error } = await context.client.auth[action === 'login' ? 'signInWithPassword' : 'signUp'](credentials);
      upstream(error, action === 'login' ? 401 : 400);
      context.cookies.clear('recovery');
      if (!data.session && action === 'signup') { saveFlow(context, 'signup'); return success(response, { requiresEmailConfirmation: true }); }
      const user = await acceptSession(context, data.session);
      context.cookies.clear('pkce');
      context.cookies.clear('flow');
      return success(response, { user });
    }
    if (action === 'google') {
      requireTerms(body);
      const { data, error } = await context.client.auth.signInWithOAuth({ provider: 'google', options: { scopes: 'openid email profile', redirectTo: `${context.cfg.origin}/auth/callback`, skipBrowserRedirect: true } });
      upstream(error);
      saveFlow(context, 'google');
      const target = new URL(data.url);
      if (target.origin !== new URL(context.cfg.url).origin || !target.pathname.endsWith('/auth/v1/authorize')) throw unavailable();
      return success(response, { redirectUrl: target.href });
    }
    if (action === 'forgot-password') {
      const address = email(body.email);
      recoveryKey(context.cfg);
      const { error } = await context.client.auth.resetPasswordForEmail(address, { redirectTo: `${context.cfg.origin}/auth/callback` });
      if (error?.code === 'auth_upstream_unavailable' || error?.status >= 500) throw unavailable();
      if (!error) saveFlow(context, 'recovery', address);
      return success(response, { message: 'If an account exists for that email, a password recovery link will be sent.' });
    }
    if (action === 'logout') {
      try {
        await authenticate(context);
        if (context.user) { await loadSdkSession(context); const { error } = await context.client.auth.signOut({ scope: 'local' }); upstream(error); }
      } finally { context.cookies.clearAll(); }
      return success(response, {});
    }
    await authenticate(context);
    if (!context.user) throw new AuthFailure(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    if (action === 'consent') {
      if (typeof body.accepted !== 'boolean' || body.version !== VERSION) throw invalidInput();
      await loadSdkSession(context);
      const { error } = await context.client.auth.updateUser({ data: { ai_processing_consent: { accepted: body.accepted, version: VERSION } } });
      upstream(error);
      return success(response, { aiConsent: body.accepted });
    }
    if (action === 'reset-password') {
      validateRecovery(context);
      const value = password(body.password);
      await loadSdkSession(context);
      const { error } = await context.client.auth.updateUser({ password: value });
      upstream(error);
      context.cookies.clear('recovery');
      return success(response, { user: context.user });
    }
  } catch (error) {
    if ((action === 'callback' || action === 'confirm') && request.method === 'GET') {
      redirect(response, '/login?error=auth_unavailable');
      return;
    }
    errorResponse(response, error);
  }
}
