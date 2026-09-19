// Shared plumbing for the Vercel function wrappers (api/*.mjs). Mirrors the
// api/chat.mjs style: method guard, per-warm-instance rate limit, declared
// body-size cap and tolerant JSON body parsing.

import { errorEnvelope, MAX_BODY_BYTES } from './anthropic.mjs';

export function clientIp(request) {
  const forwarded = request.headers['x-forwarded-for'];
  const first = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  return first || request.socket?.remoteAddress || '';
}

export function guardPost(request, response, useMessage) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).json(errorEnvelope('VALIDATION_ERROR', useMessage, false));
    return false;
  }
  return true;
}

export function guardRateLimit(request, response, rateLimiter) {
  const verdict = rateLimiter.check(clientIp(request));
  if (!verdict.allowed) {
    response.setHeader('Retry-After', String(verdict.retryAfterSeconds));
    response.status(429).json(errorEnvelope('LIMIT_EXCEEDED', 'Too many requests. Please wait a moment and try again.', true));
    return false;
  }
  return true;
}

export function guardBodySize(request, response, maxBytes = MAX_BODY_BYTES, limitMessage = 'Request body may be at most 256 KiB.') {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    response.status(400).json(errorEnvelope('VALIDATION_ERROR', limitMessage, false));
    return false;
  }
  return true;
}

export function parsedBody(request) {
  let body = request.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = undefined;
    }
  }
  return body;
}
