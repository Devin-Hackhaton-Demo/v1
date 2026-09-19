// Pure request handlers for the user-connections backend: authentication via
// GoTrue, connection rows + Vault-backed secrets via PostgREST RPCs
// (supabase/migrations/20260919140000_user_connections.sql), and live provider
// health checks. Every handler returns { status, payload } with the shared
// envelope, so both the Vercel functions and the local preview server can wire
// them without duplicating logic.
//
// Secrets policy: credentials and JWTs only ever travel in outbound request
// headers/bodies toward Supabase or the provider being checked. They are never
// logged, never echoed into responses, and provider response bodies are never
// forwarded verbatim.

import { errorEnvelope, successEnvelope } from './anthropic.mjs';
import { gotrueToken, pgRestGet, pgRpc, readSupabaseEnv } from './supabase.mjs';

export const LOGIN_RATE_LIMIT = { limit: 5, windowMs: 60000 };
export const CHECK_RATE_LIMIT = { limit: 10, windowMs: 60000 };

const CONNECTABLE_PROVIDERS = ['github', 'notion', 'vercel', 'supabase', 'composio'];
const MAX_EMAIL_CHARS = 320;
const MAX_PASSWORD_CHARS = 1024;
const MAX_REFRESH_TOKEN_CHARS = 4096;
const MAX_SECRET_CHARS = 4096;
const MAX_LABEL_CHARS = 120;
const HEALTH_TIMEOUT_MS = 15000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

const notConfigured = () => ({ status: 503, payload: errorEnvelope('PROVIDER_ERROR', 'Connections backend is not configured.', false) });
const signInRequired = () => ({ status: 401, payload: errorEnvelope('UNAUTHENTICATED', 'Sign in required.', false) });
const validationError = (message) => ({ status: 400, payload: errorEnvelope('VALIDATION_ERROR', message, false) });
const providerError = (message) => ({ status: 502, payload: errorEnvelope('PROVIDER_ERROR', message, true) });
const notFound = () => ({ status: 404, payload: errorEnvelope('NOT_FOUND', 'Connection not found.', false) });

// Extracts the JWT from an Authorization header value; '' when absent/malformed.
export function bearerToken(headerValue) {
  if (typeof headerValue !== 'string') return '';
  const match = headerValue.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : '';
}

function sessionData(payload) {
  return {
    access_token: typeof payload?.access_token === 'string' ? payload.access_token : '',
    refresh_token: typeof payload?.refresh_token === 'string' ? payload.refresh_token : '',
    expires_in: Number(payload?.expires_in) || 0,
    user: {
      id: typeof payload?.user?.id === 'string' ? payload.user.id : '',
      email: typeof payload?.user?.email === 'string' ? payload.user.email : '',
    },
  };
}

async function grantSession(config, grantType, body, failureMessage, fetchImpl) {
  let result;
  try {
    result = await gotrueToken(config, grantType, body, fetchImpl);
  } catch {
    return providerError('The sign-in service did not respond. Please try again.');
  }
  if (result.status === 200 && isPlainObject(result.payload)) {
    return { status: 200, payload: successEnvelope(sessionData(result.payload)) };
  }
  if ([400, 401, 403].includes(result.status)) {
    return { status: 401, payload: errorEnvelope('UNAUTHENTICATED', failureMessage, false) };
  }
  return providerError('The sign-in service did not respond. Please try again.');
}

export async function handleLoginRequest(body, env, fetchImpl = fetch) {
  const config = readSupabaseEnv(env);
  if (!config) return notConfigured();
  if (!isPlainObject(body) || Object.keys(body).some((key) => !['email', 'password'].includes(key))) {
    return validationError('Request body must be a JSON object with "email" and "password".');
  }
  const { email, password } = body;
  if (typeof email !== 'string' || email.length === 0 || email.length > MAX_EMAIL_CHARS || !email.includes('@')) {
    return validationError('"email" must be a valid email address.');
  }
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_CHARS) {
    return validationError('"password" must be a non-empty string.');
  }
  return grantSession(config, 'password', { email, password }, 'Invalid email or password.', fetchImpl);
}

export async function handleRefreshRequest(body, env, fetchImpl = fetch) {
  const config = readSupabaseEnv(env);
  if (!config) return notConfigured();
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'refresh_token')) {
    return validationError('Request body must be a JSON object with "refresh_token".');
  }
  const { refresh_token: refreshToken } = body;
  if (typeof refreshToken !== 'string' || refreshToken.length === 0 || refreshToken.length > MAX_REFRESH_TOKEN_CHARS) {
    return validationError('"refresh_token" must be a non-empty string.');
  }
  return grantSession(config, 'refresh_token', { refresh_token: refreshToken }, 'Session expired. Sign in again.', fetchImpl);
}

const CONNECTION_LIST_PATH = '/user_connections?select=id,provider,label,scopes,created_at&revoked_at=is.null&order=created_at.desc';

export async function handleListConnectionsRequest(jwt, env, fetchImpl = fetch) {
  const config = readSupabaseEnv(env);
  if (!config) return notConfigured();
  if (!jwt) return signInRequired();
  let result;
  try {
    result = await pgRestGet(config, CONNECTION_LIST_PATH, jwt, fetchImpl);
  } catch {
    return providerError('Could not load connections.');
  }
  if ([401, 403].includes(result.status)) return signInRequired();
  if (result.status !== 200 || !Array.isArray(result.payload)) return providerError('Could not load connections.');
  return { status: 200, payload: successEnvelope({ connections: result.payload }) };
}

export async function handleCreateConnectionRequest(jwt, body, env, fetchImpl = fetch) {
  const config = readSupabaseEnv(env);
  if (!config) return notConfigured();
  if (!jwt) return signInRequired();
  if (!isPlainObject(body) || Object.keys(body).some((key) => !['provider', 'secret', 'label'].includes(key))) {
    return validationError('Request body must be a JSON object with "provider", "secret" and an optional "label".');
  }
  const { provider, secret } = body;
  if (provider === 'google') return validationError('Google connects via OAuth.');
  if (!CONNECTABLE_PROVIDERS.includes(provider)) {
    return validationError(`"provider" must be one of ${CONNECTABLE_PROVIDERS.join(', ')}.`);
  }
  if (typeof secret !== 'string' || secret.length === 0 || secret.length > MAX_SECRET_CHARS) {
    return validationError(`"secret" must be a string of 1 to ${MAX_SECRET_CHARS} characters.`);
  }
  const label = body.label === undefined ? '' : body.label;
  if (typeof label !== 'string' || label.length > MAX_LABEL_CHARS) {
    return validationError(`"label" must be a string of at most ${MAX_LABEL_CHARS} characters.`);
  }
  let result;
  try {
    result = await pgRpc(config, 'store_user_connection', {
      p_provider: provider,
      p_secret: secret,
      p_label: label,
      p_scopes: [],
      p_metadata: {},
    }, { jwt }, fetchImpl);
  } catch {
    return providerError('Could not store the connection.');
  }
  if ([401, 403].includes(result.status)) return signInRequired();
  if (result.status !== 200 || !isPlainObject(result.payload)) {
    console.error('store_user_connection failed with status', result.status);
    return providerError('Could not store the connection.');
  }
  // Only allowlisted, non-secret fields ever reach the browser.
  const row = result.payload;
  return { status: 200, payload: successEnvelope({ connection: { id: row.id, provider: row.provider, label: row.label } }) };
}

const rpcSaysNotFound = (payload) => isPlainObject(payload) && typeof payload.message === 'string' && payload.message.includes('NOT_FOUND');

export async function handleRevokeConnectionRequest(jwt, body, env, fetchImpl = fetch) {
  const config = readSupabaseEnv(env);
  if (!config) return notConfigured();
  if (!jwt) return signInRequired();
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'id') || typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
    return validationError('Request body must be a JSON object with a connection "id" (UUID).');
  }
  let result;
  try {
    result = await pgRpc(config, 'revoke_user_connection', { p_connection_id: body.id }, { jwt }, fetchImpl);
  } catch {
    return providerError('Could not revoke the connection.');
  }
  if ([401, 403].includes(result.status)) return signInRequired();
  if (result.status === 200) return { status: 200, payload: successEnvelope({ revoked: true }) };
  // Foreign and missing ids both surface as NOT_FOUND (no existence leak).
  if (rpcSaysNotFound(result.payload)) return notFound();
  console.error('revoke_user_connection failed with status', result.status);
  return providerError('Could not revoke the connection.');
}

// Provider health registry. Each entry builds an authenticated GET and derives
// a small, non-secret account summary from a 2xx response body.
export const PROVIDER_HEALTH_CHECKS = {
  github: {
    request: (secret) => ({
      url: 'https://api.github.com/user',
      // GitHub requires a User-Agent on every API request.
      headers: { Authorization: `Bearer ${secret}`, 'X-GitHub-Api-Version': '2022-11-28', Accept: 'application/vnd.github+json', 'User-Agent': 'coffeenator' },
    }),
    account: (payload) => (typeof payload?.login === 'string' ? payload.login : 'GitHub account'),
  },
  notion: {
    request: (secret) => ({
      url: 'https://api.notion.com/v1/users/me',
      headers: { Authorization: `Bearer ${secret}`, 'Notion-Version': '2022-06-28' },
    }),
    account: (payload) => payload?.name || payload?.bot?.workspace_name || 'Notion workspace',
  },
  vercel: {
    request: (secret) => ({ url: 'https://api.vercel.com/v2/user', headers: { Authorization: `Bearer ${secret}` } }),
    account: (payload) => payload?.user?.username || payload?.user?.email || 'Vercel account',
  },
  supabase: {
    request: (secret) => ({ url: 'https://api.supabase.com/v1/projects', headers: { Authorization: `Bearer ${secret}` } }),
    account: (payload) => `${Array.isArray(payload) ? payload.length : 0} project(s)`,
  },
  // Composio REST API v3.1 (verified against the docs on 2026-09-19):
  //   base URL https://backend.composio.dev/api/v3.1, project API keys go in
  //   the x-api-key header. Cheapest authenticated GET is the connected
  //   accounts list (limit=1); its response includes a required total_items.
  //   Sources: https://docs.composio.dev/reference (base URL + auth header),
  //   https://docs.composio.dev/reference/api-reference/connected-accounts/getConnectedAccounts
  composio: {
    request: (secret) => ({
      url: 'https://backend.composio.dev/api/v3.1/connected_accounts?limit=1',
      headers: { 'x-api-key': secret },
    }),
    account: (payload) => `${Number.isFinite(Number(payload?.total_items)) ? Number(payload.total_items) : 0} connected account(s)`,
  },
};

async function runHealthCheck(provider, secret, fetchImpl) {
  const check = PROVIDER_HEALTH_CHECKS[provider];
  const { url, headers } = check.request(secret);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, { headers, signal: controller.signal });
  } catch {
    return { provider, healthy: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
  if ([401, 403].includes(response.status)) return { provider, healthy: false, reason: 'unauthorized' };
  if (!response.ok) return { provider, healthy: false, reason: 'unreachable' };
  const payload = await response.json().catch(() => null);
  return { provider, healthy: true, account: check.account(payload) };
}

export async function handleCheckConnectionRequest(jwt, body, env, fetchImpl = fetch) {
  const config = readSupabaseEnv(env);
  if (!config) return notConfigured();
  if (!jwt) return signInRequired();
  if (!isPlainObject(body) || Object.keys(body).some((key) => key !== 'id') || typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
    return validationError('Request body must be a JSON object with a connection "id" (UUID).');
  }
  // (a) Ownership: fetch the row as the signed-in user — RLS hides foreign rows,
  // so a foreign id looks exactly like a missing one.
  let row;
  try {
    const result = await pgRestGet(config, `/user_connections?select=id,provider&id=eq.${body.id}&revoked_at=is.null`, jwt, fetchImpl);
    if ([401, 403].includes(result.status)) return signInRequired();
    if (result.status !== 200 || !Array.isArray(result.payload)) return providerError('Could not check the connection.');
    row = result.payload[0];
  } catch {
    return providerError('Could not check the connection.');
  }
  if (!isPlainObject(row)) return notFound();
  const provider = row.provider;
  if (!PROVIDER_HEALTH_CHECKS[provider]) {
    return validationError('This provider does not support health checks.');
  }
  // (b) Secret read-back: service role only (execute is revoked from other roles).
  let secret;
  try {
    const result = await pgRpc(config, 'get_user_connection_secret', { p_connection_id: body.id }, { serviceRole: true }, fetchImpl);
    if (result.status !== 200 || typeof result.payload !== 'string') {
      if (rpcSaysNotFound(result.payload)) return notFound();
      console.error('get_user_connection_secret failed with status', result.status);
      return providerError('Could not check the connection.');
    }
    secret = result.payload;
  } catch {
    return providerError('Could not check the connection.');
  }
  // (c) Provider health call. ok:true whenever the check itself ran.
  const data = await runHealthCheck(provider, secret, fetchImpl);
  return { status: 200, payload: successEnvelope(data) };
}
