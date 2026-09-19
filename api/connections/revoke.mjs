import { bearerToken, handleRevokeConnectionRequest } from '../_lib/connections.mjs';
import { guardBodySize, guardPost, parsedBody } from '../_lib/http.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (!guardPost(request, response, 'Use POST to revoke a connection.')) return;
  if (!guardBodySize(request, response)) return;
  const jwt = bearerToken(request.headers.authorization);
  const { status, payload } = await handleRevokeConnectionRequest(jwt, parsedBody(request), process.env);
  response.status(status).json(payload);
}
