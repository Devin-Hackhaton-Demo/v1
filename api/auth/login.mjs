import { handleDemoAuthRequest } from '../_lib/demo-auth.mjs';

// Per-warm-instance limiter (same v1 acceptance as api/chat.mjs): 5/60s/IP.
export default async function handler(request, response) {
  await handleDemoAuthRequest(request, response);
}
