import { createRateLimiter } from '../_lib/anthropic.mjs';
import { CHECK_RATE_LIMIT, handleCheckConnectionRequest } from '../_lib/connections.mjs';
import { requireDemoAuth } from '../_lib/demo-auth.mjs';
import { guardBodySize, guardPost, guardRateLimit, parsedBody } from '../_lib/http.mjs';

// Per-warm-instance limiter (same v1 acceptance as api/chat.mjs): 10/60s/IP.
const rateLimiter = createRateLimiter(CHECK_RATE_LIMIT);

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const session = await requireDemoAuth(request, response);
  if (!session) return;
  if (!guardPost(request, response, 'Use POST to check a connection.')) return;
  if (!guardRateLimit(request, response, rateLimiter)) return;
  if (!guardBodySize(request, response)) return;
  const jwt = session.accessToken;
  const { status, payload } = await handleCheckConnectionRequest(jwt, parsedBody(request), process.env);
  response.status(status).json(payload);
}
