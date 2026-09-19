import { handleRevokeConnectionRequest } from '../_lib/connections.mjs';
import { requireDemoAuth } from '../_lib/demo-auth.mjs';
import { guardBodySize, guardPost, parsedBody } from '../_lib/http.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const session = await requireDemoAuth(request, response);
  if (!session) return;
  if (!guardPost(request, response, 'Use POST to revoke a connection.')) return;
  if (!guardBodySize(request, response)) return;
  const jwt = session.accessToken;
  const { status, payload } = await handleRevokeConnectionRequest(jwt, parsedBody(request), process.env);
  response.status(status).json(payload);
}
