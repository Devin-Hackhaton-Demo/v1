import { createRateLimiter } from './_lib/anthropic.mjs';
import { guardBodySize, guardRateLimit, parsedBody } from './_lib/http.mjs';
import { handleMcpHttp } from './_lib/mcp.mjs';

// Public, stateless MCP endpoint (Streamable HTTP, JSON responses), served at
// /mcp through the vercel.json rewrite. Per-warm-instance limiter, 10/60s/IP,
// same v1 acceptance as api/chat.mjs.
const rateLimiter = createRateLimiter();

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'POST') {
    if (!guardRateLimit(request, response, rateLimiter)) return;
    if (!guardBodySize(request, response)) return;
  }
  let body;
  try { body = request.method === 'POST' ? parsedBody(request) : undefined; } catch { body = undefined; }
  const result = await handleMcpHttp({ method: request.method, headers: request.headers, body }, { env: process.env, fetchImpl: fetch });
  for (const [name, value] of Object.entries(result.headers || {})) response.setHeader(name, value);
  if (result.body === null || result.body === undefined) { response.status(result.status).end(); return; }
  response.status(result.status).json(result.body);
}
