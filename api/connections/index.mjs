import { errorEnvelope } from '../_lib/anthropic.mjs';
import { bearerToken, handleCreateConnectionRequest, handleListConnectionsRequest } from '../_lib/connections.mjs';
import { guardBodySize, parsedBody } from '../_lib/http.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const jwt = bearerToken(request.headers.authorization);
  if (request.method === 'GET') {
    const { status, payload } = await handleListConnectionsRequest(jwt, process.env);
    response.status(status).json(payload);
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'GET, POST');
    response.status(405).json(errorEnvelope('VALIDATION_ERROR', 'Use GET to list connections or POST to create one.', false));
    return;
  }
  if (!guardBodySize(request, response)) return;
  const { status, payload } = await handleCreateConnectionRequest(jwt, parsedBody(request), process.env);
  response.status(status).json(payload);
}
