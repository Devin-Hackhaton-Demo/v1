import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './types.ts';

export type DbClient = SupabaseClient<Database>;

function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

/**
 * Kliensoldali (RLS-sel védett) Supabase kliens. A UI-ban explicit
 * url/key paraméterrel hívandó (ott nincs process.env).
 */
export function createAnonClient(
  url = env('SUPABASE_URL'),
  anonKey = env('SUPABASE_ANON_KEY'),
): DbClient {
  if (!url || !anonKey) {
    throw new Error('createAnonClient: SUPABASE_URL és SUPABASE_ANON_KEY szükséges');
  }
  return createClient<Database>(url, anonKey);
}

/**
 * Service role kliens — RLS-t megkerüli. KIZÁRÓLAG szerveroldali
 * folyamatban (seed, worker, API) használható, UI bundle-be nem kerülhet.
 */
export function createServiceClient(
  url = env('SUPABASE_URL'),
  serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY'),
): DbClient {
  if (!url || !serviceRoleKey) {
    throw new Error('createServiceClient: SUPABASE_URL és SUPABASE_SERVICE_ROLE_KEY szükséges');
  }
  return createClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
