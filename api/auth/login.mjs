import { createRateLimiter } from '../_lib/anthropic.mjs';
import { handleLoginRequest, LOGIN_RATE_LIMIT } from '../_lib/connections.mjs';
import { guardBodySize, guardPost, guardRateLimit, parsedBody } from '../_lib/http.mjs';

// Per-warm-instance limiter (same v1 acceptance as api/chat.mjs): 5/60s/IP.
const rateLimiter = createRateLimiter(LOGIN_RATE_LIMIT);

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!guardPost(request, response, 'Use POST to sign in.')) return;
  if (!guardRateLimit(request, response, rateLimiter)) return;
  if (!guardBodySize(request, response)) return;
  const { status, payload } = await handleLoginRequest(parsedBody(request), process.env);
  response.status(status).json(payload);
}
