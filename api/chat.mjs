import { createRateLimiter, errorEnvelope, handleChatRequest, MAX_BODY_BYTES } from './_lib/anthropic.mjs';

// Per-warm-instance limiter: each Vercel instance counts independently, so the
// effective global limit scales with concurrent warm instances. Accepted for v1.
const rateLimiter = createRateLimiter();

function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first || request.socket?.remoteAddress || '';
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).json(errorEnvelope('VALIDATION_ERROR', 'Use POST to talk to /api/chat.', false));
    return;
  }
  const verdict = rateLimiter.check(clientIp(request));
  if (!verdict.allowed) {
    response.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    response.status(429).json(errorEnvelope('LIMIT_EXCEEDED', 'Too many requests. Please wait a moment and try again.', true));
    return;
  }
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    response.status(400).json(errorEnvelope('VALIDATION_ERROR', 'Request body may be at most 256 KiB.', false));
    return;
  }
  let body = request.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  const { status, payload } = await handleChatRequest(body, process.env);
  response.status(status).json(payload);
}
