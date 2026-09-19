import { createRateLimiter } from '../_lib/anthropic.mjs';
import { CHECK_RATE_LIMIT, handleComposioKeyCheck } from '../_lib/connections.mjs';
import { guardBodySize, guardPost, guardRateLimit, parsedBody } from '../_lib/http.mjs';

// Per-warm-instance limiter (same v1 acceptance as api/chat.mjs): 10/60s/IP.
const rateLimiter = createRateLimiter(CHECK_RATE_LIMIT);

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!guardPost(request, response, 'Use POST to check a Composio API key.')) return;
  if (!guardRateLimit(request, response, rateLimiter)) return;
  if (!guardBodySize(request, response)) return;
  const { status, payload } = await handleComposioKeyCheck(parsedBody(request));
  response.status(status).json(payload);
}
