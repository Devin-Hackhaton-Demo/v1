import { handleRefreshRequest } from '../_lib/connections.mjs';
import { guardBodySize, guardPost, parsedBody } from '../_lib/http.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!guardPost(request, response, 'Use POST to refresh a session.')) return;
  if (!guardBodySize(request, response)) return;
  const { status, payload } = await handleRefreshRequest(parsedBody(request), process.env);
  response.status(status).json(payload);
}
