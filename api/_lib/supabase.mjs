// Server-side Supabase access over plain fetch (Node builtins only, no SDK):
// GoTrue for authentication, PostgREST for rows and RPCs. The browser never
// talks to Supabase directly — it only calls same-origin /api/* endpoints,
// so the CSP connect-src 'self' stays intact.
//
// Secrets policy: keys and JWTs are only ever placed into outbound request
// headers here. Nothing in this module logs or returns them.

export function readSupabaseEnv(env) {
  const url = typeof env?.SUPABASE_URL === 'string' ? env.SUPABASE_URL.replace(/\/+$/, '') : '';
  const anonKey = typeof env?.SUPABASE_ANON_KEY === 'string' ? env.SUPABASE_ANON_KEY : '';
  const serviceRoleKey = typeof env?.SUPABASE_SERVICE_ROLE_KEY === 'string' ? env.SUPABASE_SERVICE_ROLE_KEY : '';
  if (!url || !anonKey || !serviceRoleKey) return null;
  return { url, anonKey, serviceRoleKey };
}

// POST {SUPABASE_URL}/auth/v1/token?grant_type=<grantType> with the anon key.
// Returns { status, payload } — never throws on HTTP errors, only on network failure.
export async function gotrueToken(config, grantType, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.url}/auth/v1/token?grant_type=${grantType}`, {
    method: 'POST',
    headers: { apikey: config.anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

// GET {SUPABASE_URL}/rest/v1<pathWithQuery> as the signed-in user (RLS applies).
export async function pgRestGet(config, pathWithQuery, userJwt, fetchImpl = fetch) {
  const response = await fetchImpl(`${config.url}/rest/v1${pathWithQuery}`, {
    headers: { apikey: config.anonKey, authorization: `Bearer ${userJwt}` },
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}

// POST {SUPABASE_URL}/rest/v1/rpc/<name>. auth is either { jwt } (anon apikey +
// user JWT: SECURITY INVOKER context sees auth.uid()) or { serviceRole: true }
// (service key as both apikey and bearer — reserved for get_user_connection_secret).
export async function pgRpc(config, name, args, auth, fetchImpl = fetch) {
  const apikey = auth.serviceRole ? config.serviceRoleKey : config.anonKey;
  const bearer = auth.serviceRole ? config.serviceRoleKey : auth.jwt;
  const response = await fetchImpl(`${config.url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey, authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, payload };
}
