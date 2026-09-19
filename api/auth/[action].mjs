import { handleAuthRequest } from '../_lib/auth.mjs';

export default async function handler(request, response) {
  await handleAuthRequest(request, response);
}
