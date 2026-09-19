import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRateLimiter, errorEnvelope, handleChatRequest, MAX_BODY_BYTES, MAX_CHAT_BODY_BYTES } from '../../../api/_lib/anthropic.mjs';
import {
  bearerToken,
  CHECK_RATE_LIMIT,
  handleCheckConnectionRequest,
  handleKeyCheck,
  handleCreateConnectionRequest,
  handleListConnectionsRequest,
  handleLoginRequest,
  handleRefreshRequest,
  handleRevokeConnectionRequest,
  LOGIN_RATE_LIMIT,
} from '../../../api/_lib/connections.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/tokens.css', ['../tokens.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/state.mjs', ['state.mjs', 'text/javascript; charset=utf-8']],
  ['/art.mjs', ['art.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/legal.css', ['legal.css', 'text/css; charset=utf-8']],
  ...['legal', 'terms', 'privacy', 'ai-data', 'cookies'].flatMap((name) => [
    [`/${name}`, [`${name}/index.html`, 'text/html; charset=utf-8']],
    [`/${name}/`, [`${name}/index.html`, 'text/html; charset=utf-8']],
  ]),
  ...['gmail', 'calendar', 'drive'].map((name) => [`/icons/${name}.png`, [`icons/${name}.png`, 'image/png']]),
  ...['github', 'supabase', 'claude', 'chatgpt'].map((name) => [`/icons/${name}.svg`, [`icons/${name}.svg`, 'image/svg+xml']]),
]);

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

// Reads and parses a JSON body, enforcing maxBytes. Returns { ok: true, body }
// or { ok: false } after having already sent the 400 response.
async function readJsonBody(request, response, maxBytes, limitMessage) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    sendJson(response, 400, errorEnvelope('VALIDATION_ERROR', limitMessage, false));
    return { ok: false };
  }
  try {
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > maxBytes) {
        sendJson(response, 400, errorEnvelope('VALIDATION_ERROR', limitMessage, false));
        return { ok: false };
      }
      chunks.push(chunk);
    }
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    sendJson(response, 400, errorEnvelope('VALIDATION_ERROR', 'Request body must be valid JSON.', false));
    return { ok: false };
  }
}

function guardPost(request, response, useMessage) {
  if (request.method !== 'POST') {
    sendJson(response, 405, errorEnvelope('VALIDATION_ERROR', useMessage, false), { Allow: 'POST' });
    return false;
  }
  return true;
}

function guardRateLimit(request, response, rateLimiter) {
  // The server binds loopback; x-forwarded-for is never trusted here.
  const verdict = rateLimiter.check(request.socket.remoteAddress || '');
  if (!verdict.allowed) {
    sendJson(response, 429, errorEnvelope('LIMIT_EXCEEDED', 'Too many requests. Please wait a moment and try again.', true), { 'Retry-After': String(verdict.retryAfterSeconds) });
    return false;
  }
  return true;
}

const BODY_LIMIT_MESSAGE = 'Request body may be at most 256 KiB.';

async function handleChatEndpoint(request, response, env, fetchImpl, rateLimiter) {
  if (!guardPost(request, response, 'Use POST to talk to /api/chat.')) return;
  if (!guardRateLimit(request, response, rateLimiter)) return;
  // /api/chat alone accepts up to 4 MiB so base64 screenshots fit.
  const read = await readJsonBody(request, response, MAX_CHAT_BODY_BYTES, 'Request body may be at most 4 MiB.');
  if (!read.ok) return;
  const { status, payload } = await handleChatRequest(read.body, env, fetchImpl);
  sendJson(response, status, payload);
}

// The same six user-connection routes the Vercel functions expose
// (api/auth/*.mjs, api/connections/*.mjs), wired against the shared handlers.
async function handleApiRoute(pathname, request, response, { env, fetchImpl, loginRateLimiter, checkRateLimiter }) {
  if (pathname === '/api/auth/login') {
    if (!guardPost(request, response, 'Use POST to sign in.')) return true;
    if (!guardRateLimit(request, response, loginRateLimiter)) return true;
    const read = await readJsonBody(request, response, MAX_BODY_BYTES, BODY_LIMIT_MESSAGE);
    if (!read.ok) return true;
    const { status, payload } = await handleLoginRequest(read.body, env, fetchImpl);
    sendJson(response, status, payload);
    return true;
  }
  if (pathname === '/api/auth/refresh') {
    if (!guardPost(request, response, 'Use POST to refresh a session.')) return true;
    const read = await readJsonBody(request, response, MAX_BODY_BYTES, BODY_LIMIT_MESSAGE);
    if (!read.ok) return true;
    const { status, payload } = await handleRefreshRequest(read.body, env, fetchImpl);
    sendJson(response, status, payload);
    return true;
  }
  if (pathname === '/api/connections') {
    const jwt = bearerToken(request.headers.authorization);
    if (request.method === 'GET') {
      const { status, payload } = await handleListConnectionsRequest(jwt, env, fetchImpl);
      sendJson(response, status, payload);
      return true;
    }
    if (request.method !== 'POST') {
      sendJson(response, 405, errorEnvelope('VALIDATION_ERROR', 'Use GET to list connections or POST to create one.', false), { Allow: 'GET, POST' });
      return true;
    }
    const read = await readJsonBody(request, response, MAX_BODY_BYTES, BODY_LIMIT_MESSAGE);
    if (!read.ok) return true;
    const { status, payload } = await handleCreateConnectionRequest(jwt, read.body, env, fetchImpl);
    sendJson(response, status, payload);
    return true;
  }
  if (pathname === '/api/connections/revoke') {
    if (!guardPost(request, response, 'Use POST to revoke a connection.')) return true;
    const read = await readJsonBody(request, response, MAX_BODY_BYTES, BODY_LIMIT_MESSAGE);
    if (!read.ok) return true;
    const jwt = bearerToken(request.headers.authorization);
    const { status, payload } = await handleRevokeConnectionRequest(jwt, read.body, env, fetchImpl);
    sendJson(response, status, payload);
    return true;
  }
  if (pathname === '/api/keys/check') {
    if (!guardPost(request, response, 'Use POST to check an API key.')) return true;
    if (!guardRateLimit(request, response, checkRateLimiter)) return true;
    const read = await readJsonBody(request, response, MAX_BODY_BYTES, BODY_LIMIT_MESSAGE);
    if (!read.ok) return true;
    const { status, payload } = await handleKeyCheck(read.body, fetchImpl);
    sendJson(response, status, payload);
    return true;
  }
  if (pathname === '/api/connections/check') {
    if (!guardPost(request, response, 'Use POST to check a connection.')) return true;
    if (!guardRateLimit(request, response, checkRateLimiter)) return true;
    const read = await readJsonBody(request, response, MAX_BODY_BYTES, BODY_LIMIT_MESSAGE);
    if (!read.ok) return true;
    const jwt = bearerToken(request.headers.authorization);
    const { status, payload } = await handleCheckConnectionRequest(jwt, read.body, env, fetchImpl);
    sendJson(response, status, payload);
    return true;
  }
  return false;
}

export function createPreviewServer({
  env = process.env,
  fetchImpl = fetch,
  rateLimiter = createRateLimiter(),
  loginRateLimiter = createRateLimiter(LOGIN_RATE_LIMIT),
  checkRateLimiter = createRateLimiter(CHECK_RATE_LIMIT),
} = {}) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'SAMEORIGIN');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
    let pathname;
    try { pathname = new URL(request.url, 'http://127.0.0.1').pathname; } catch { response.writeHead(400).end(); return; }
    if (pathname === '/api/chat') {
      await handleChatEndpoint(request, response, env, fetchImpl, rateLimiter);
      return;
    }
    if (pathname.startsWith('/api/') && await handleApiRoute(pathname, request, response, { env, fetchImpl, loginRateLimiter, checkRateLimiter })) {
      return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('This address does not accept data or API requests.');
      return;
    }
    const asset = files.get(pathname);
    if (!asset) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('This page is not part of Coffeenator.');
      return;
    }
    try {
      const body = await readFile(new URL(asset[0], import.meta.url));
      response.writeHead(200, { 'Content-Type': asset[1], 'Content-Length': body.length });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch {
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('A required asset is not available yet.');
    }
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => console.log(`Coffeenator: http://127.0.0.1:${port}`));
  server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Choose another PORT value.` : 'The local server could not start.');
    process.exitCode = 1;
  });
}
