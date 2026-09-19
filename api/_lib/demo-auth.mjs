import { createHash, timingSafeEqual } from 'node:crypto';
import { getAuthContext, getVerifiedSession, handleAuthRequest, requireAuth } from './auth.mjs';

const attempts = new Map();
const normalizeEmail = (value) => typeof value === 'string' ? value.trim().toLowerCase() : '';
const digest = (value) => createHash('sha256').update(value).digest();

function headers(response) {
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
function failure(response, status, code, message) {
  json(response, status, { ok: false, error: { code, message, retryable: false } });
}
function unavailable(response) {
  failure(response, 503, 'AUTH_UNAVAILABLE', 'Authentication is temporarily unavailable. Please try again.');
}
function rateLimit(request, response, env, action) {
  const now = Date.now();
  for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
  const key = JSON.stringify([env.APP_ORIGIN, request.socket?.remoteAddress || 'unknown', action]);
  let record = attempts.get(key);
  if (!record && attempts.size < 5000) {
    record = { count: 0, until: now + 60000 };
    attempts.set(key, record);
  }
  if (!record || ++record.count > (action === 'login' ? 5 : action === 'session' ? 120 : 20)) {
    response.setHeader('Retry-After', String(record ? Math.max(1, Math.ceil((record.until - now) / 1000)) : 60));
    failure(response, 429, 'RATE_LIMITED', 'Too many authentication attempts. Please wait and try again.');
    return false;
  }
  return true;
}
function optionsFor(env, fetchImpl) {
  const email = normalizeEmail(env.DEMO_USER_EMAIL ?? 'owner@demo.test');
  const password = env.DEMO_USER_PASSWORD;
  if (email !== 'owner@demo.test' || typeof password !== 'string' || !password.trim()) throw new Error('Authentication unavailable');
  return {
    env,
    fetchImpl,
    rejectAnonymousFirst: true,
    authorizeUser: (user) => normalizeEmail(user?.email) === email,
    validateLogin(credentials) {
      const emailMatches = timingSafeEqual(digest(normalizeEmail(credentials.email)), digest(email));
      const passwordMatches = timingSafeEqual(digest(credentials.password), digest(password));
      if (!emailMatches || !passwordMatches) return false;
      credentials.email = email;
      return true;
    },
  };
}

export async function handleDemoAuthRequest(request, response, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  headers(response);
  const action = typeof request.url === 'string' && request.url.length <= 8192
    ? /^\/api\/auth\/(session|login|logout)(?:\?[^#]*)?$/.exec(request.url)?.[1] : undefined;
  if (!action) {
    failure(response, 404, 'NOT_FOUND', 'This authentication endpoint does not exist.');
    return;
  }
  const method = action === 'session' ? 'GET' : 'POST';
  if (request.method !== method) {
    response.setHeader('Allow', method);
    failure(response, 405, 'METHOD_NOT_ALLOWED', 'This request method is not supported.');
    return;
  }
  if (!rateLimit(request, response, env, action)) return;
  try {
    const options = optionsFor(env, fetchImpl);
    if (action === 'session') {
      const data = await getAuthContext(request, response, options);
      json(response, 200, { ok: true, data });
      return;
    }
    await handleAuthRequest(request, response, options);
  } catch {
    if (!response.writableEnded) unavailable(response);
  }
}

export async function requireDemoAuth(request, response, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  headers(response);
  try {
    const user = await requireAuth(request, response, optionsFor(env, fetchImpl));
    if (!user) return null;
    return getVerifiedSession(request);
  } catch {
    if (!response.writableEnded) unavailable(response);
    return null;
  }
}
