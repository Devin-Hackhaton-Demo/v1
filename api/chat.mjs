import { errorEnvelope, handleChatRequest, MAX_BODY_BYTES } from './_lib/anthropic.mjs';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    response.status(405).json(errorEnvelope('VALIDATION_ERROR', 'Use POST to talk to /api/chat.', false));
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
