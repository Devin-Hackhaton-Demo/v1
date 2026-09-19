import type { DbClient } from '../client.ts';
import type { Enums, Json, Tables } from '../types.ts';

/**
 * Typed wrappers around the user-scoped provider connection RPCs
 * (supabase/migrations/20260919140000_user_connections.sql).
 *
 * The credential itself lives in Supabase Vault; the public row stores only
 * a `secret_ref` (vault.secrets.id). All writes go through SECURITY DEFINER
 * functions so the Vault bookkeeping can never be skipped — there are no
 * insert/update/delete RLS policies on the table.
 */

/**
 * A user connection as returned by the store/revoke RPCs: the `secret_ref`
 * Vault reference is stripped server-side (clients never need it).
 */
export type UserConnectionPublic = Omit<Tables<'user_connections'>, 'secret_ref'>;

export interface StoreUserConnectionInput {
  provider: Enums<'provider_kind'>;
  /** The raw credential — written into Vault, never into a public table. */
  secret: string;
  /** Human-readable account label (email/workspace); never secret material. */
  label?: string;
  scopes?: string[];
  /** Non-secret provider metadata only (must be a JSON object). */
  metadata?: Json;
}

/**
 * Create or rotate a connection for the signed-in user. Upsert semantics on
 * (user, provider, label): an active row gets its Vault secret rotated in
 * place; otherwise a new Vault secret + row is created. The returned row
 * never contains the secret or the Vault reference.
 */
export async function storeUserConnection(
  client: DbClient,
  input: StoreUserConnectionInput,
): Promise<UserConnectionPublic> {
  const { data, error } = await client.rpc('store_user_connection', {
    p_provider: input.provider,
    p_secret: input.secret,
    p_label: input.label ?? '',
    p_scopes: input.scopes ?? [],
    p_metadata: input.metadata ?? {},
  });
  if (error) throw error;
  return data as unknown as UserConnectionPublic;
}

/**
 * The signed-in user's own connections (RLS scopes the select to
 * `user_id = auth.uid()`). Direct selects may include `secret_ref` — that is
 * only a Vault reference the owner may see, never secret material.
 */
export async function listUserConnections(client: DbClient): Promise<Tables<'user_connections'>[]> {
  const { data, error } = await client
    .from('user_connections')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * Revoke an own connection: the Vault secret row is deleted, `revoked_at`
 * set, `secret_ref` nulled. Idempotent — revoking an already-revoked
 * connection returns the row unchanged. Foreign/missing ids raise NOT_FOUND
 * without revealing existence.
 */
export async function revokeUserConnection(
  client: DbClient,
  connectionId: string,
): Promise<UserConnectionPublic> {
  const { data, error } = await client.rpc('revoke_user_connection', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
  return data as unknown as UserConnectionPublic;
}

/**
 * SERVICE ROLE ONLY: decrypt and return the credential of an active
 * connection from Vault. Must be called with `createServiceClient()` from a
 * server-side process (the MCP backend fetches it at call time); execute is
 * revoked from authenticated/anon, so a user-facing client call fails with a
 * permission error by design. Raises NOT_FOUND for revoked/missing rows.
 */
export async function getUserConnectionSecret(
  serviceClient: DbClient,
  connectionId: string,
): Promise<string> {
  const { data, error } = await serviceClient.rpc('get_user_connection_secret', {
    p_connection_id: connectionId,
  });
  if (error) throw error;
  return data as unknown as string;
}
