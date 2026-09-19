import { handleDemoAuthRequest } from '../_lib/demo-auth.mjs';

export default async function handler(request, response) {
  await handleDemoAuthRequest(request, response);
}
