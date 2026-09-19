import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createRateLimiter, errorEnvelope, handleChatRequest, MAX_BODY_BYTES } from '../../../api/_lib/anthropic.mjs';

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/tokens.css', ['../tokens.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/state.mjs', ['state.mjs', 'text/javascript; charset=utf-8']],
  ['/art.mjs', ['art.mjs', 'text/javascript; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ...['gmail', 'calendar', 'drive'].map((name) => [`/icons/${name}.png`, [`icons/${name}.png`, 'image/png']]),
  ...['github', 'supabase', 'claude', 'chatgpt', 'composio-black', 'composio-white'].map((name) => [`/icons/${name}.svg`, [`icons/${name}.svg`, 'image/svg+xml']]),
]);

function sendJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  response.end(body);
}

async function handleChatEndpoint(request, response, env, fetchImpl, rateLimiter) {
  if (request.method !== 'POST') {
    sendJson(response, 405, errorEnvelope('VALIDATION_ERROR', 'Use POST to talk to /api/chat.', false), { Allow: 'POST' });
    return;
  }
  // The server binds loopback; x-forwarded-for is never trusted here.
  const verdict = rateLimiter.check(request.socket.remoteAddress || '');
  if (!verdict.allowed) {
    sendJson(response, 429, errorEnvelope('LIMIT_EXCEEDED', 'Too many requests. Please wait a moment and try again.', true), { 'Retry-After': String(verdict.retryAfterSeconds) });
    return;
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    sendJson(response, 400, errorEnvelope('VALIDATION_ERROR', 'Request body may be at most 256 KiB.', false));
    return;
  }
  let body;
  try {
    const chunks = [];
    let received = 0;
    for await (const chunk of request) {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        sendJson(response, 400, errorEnvelope('VALIDATION_ERROR', 'Request body may be at most 256 KiB.', false));
        return;
      }
      chunks.push(chunk);
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    sendJson(response, 400, errorEnvelope('VALIDATION_ERROR', 'Request body must be valid JSON.', false));
    return;
  }
  const { status, payload } = await handleChatRequest(body, env, fetchImpl);
  sendJson(response, status, payload);
}

export function createPreviewServer({ env = process.env, fetchImpl = fetch, rateLimiter = createRateLimiter() } = {}) {
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
