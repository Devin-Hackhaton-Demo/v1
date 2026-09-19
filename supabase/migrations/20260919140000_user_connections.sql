-- 7 — user-scoped provider connections with Supabase Vault-backed secrets.
--
-- The MCP server lets a user supply an API key / OAuth token for an external
-- provider once; any AI client connected as that user can then use it. The
-- existing `connections` table is project-scoped and GitHub-only and stays
-- untouched — this adds a separate, user-scoped model.
--
-- Secrets policy (PROJECT_CONTEXT.md section 7, AGENTS.md): a secret NEVER
-- lands in a public table. The credential itself goes into Supabase Vault
-- (supabase_vault 0.3.1 — encrypted at rest, key held outside the DB);
-- public.user_connections stores only the vault.secrets.id reference.
--
-- All writes go through the SECURITY DEFINER functions below. There are NO
-- insert/update/delete RLS policies on purpose: this guarantees the Vault
-- bookkeeping (create/update/delete of the vault row) can never be skipped
-- by a direct table write. The service role bypasses RLS for cleanup.

create type public.provider_kind as enum (
  'google', 'github', 'vercel', 'composio', 'supabase', 'notion'
);

create table public.user_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider public.provider_kind not null,
  -- Human-readable account label (email/workspace name); never secret material.
  label text not null default '' check (char_length(label) <= 200),
  -- vault.secrets.id — a secret-store reference ONLY, never the secret itself.
  -- NULL after revocation (the Vault row is deleted).
  secret_ref uuid,
  scopes text[] not null default '{}',
  -- Non-secret provider metadata only (e.g. workspace id, account type).
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (user_id, provider, label)
);

create index user_connections_user_idx on public.user_connections (user_id);

comment on table public.user_connections is
  'User-scoped external provider connections. The credential lives in Supabase Vault; secret_ref is the vault.secrets.id reference only.';
comment on column public.user_connections.label is
  'Human-readable account label (email/workspace); never secret material.';
comment on column public.user_connections.secret_ref is
  'vault.secrets.id — secret-store reference only; NULL after revocation (the Vault row is deleted).';
comment on column public.user_connections.metadata is
  'Non-secret provider metadata only. Secrets must go through store_user_connection into Vault.';

-- RLS: owners may read their own rows; NO write policies — every write goes
-- through the SECURITY DEFINER functions below (service_role bypasses RLS).
alter table public.user_connections enable row level security;

create policy user_connections_select on public.user_connections
  for select to authenticated
  using (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- store_user_connection: create or rotate a user connection + Vault secret.
--   * auth.uid() must be non-null → else UNAUTHENTICATED.
--   * p_secret byte length must be 1..8192 → else VALIDATION_ERROR.
--   * p_metadata must be a jsonb object → else VALIDATION_ERROR.
--   * Upsert semantics on (auth.uid(), provider, label):
--       - ACTIVE row exists → rotate the Vault secret in place via
--         vault.update_secret and refresh scopes/metadata/updated_at.
--       - REVOKED row exists → re-activate it with a fresh Vault secret
--         (its old Vault row was deleted at revocation). This keeps the
--         (user_id, provider, label) unique key satisfiable after a revoke.
--       - no row → vault.create_secret + INSERT.
--   * Returns the full row as jsonb WITHOUT secret_ref: clients never need
--     the Vault id, and the secret itself never appears in any response.
--
-- Invocation guidance: prefer server-side invocation from the MCP backend.
-- Direct client invocation is acceptable for v1, BUT the secret transits as
-- an RPC argument. LIMITATION (verified 2026-09-19 on this project):
-- `alter function ... set log_statement = 'none'` is rejected with
-- "permission denied to set parameter" — log_statement is a superuser-only
-- (SUSET) parameter and the Supabase `postgres` role is not superuser, so a
-- per-function logging opt-out cannot be installed here. Statement logging
-- must therefore stay off at the project level for this function's argument
-- values to never be logged (Supabase default: log_statement=ddl, so plain
-- RPC CALLs/SELECTs are not logged).
-- ---------------------------------------------------------------------------
create or replace function public.store_user_connection(
  p_provider public.provider_kind,
  p_secret text,
  p_label text default '',
  p_scopes text[] default '{}',
  p_metadata jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_label text := coalesce(p_label, '');
  v_row public.user_connections;
  v_secret_id uuid;
begin
  if v_uid is null then
    raise exception 'UNAUTHENTICATED';
  end if;

  -- Byte-length cap: a credential is a byte string; 8 KiB is far above any
  -- real provider token while still bounding Vault row size.
  if p_secret is null or octet_length(p_secret) < 1 or octet_length(p_secret) > 8192 then
    raise exception 'VALIDATION_ERROR: secret length';
  end if;

  if p_metadata is null or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'VALIDATION_ERROR: metadata must be a JSON object';
  end if;

  select * into v_row
    from public.user_connections
   where user_id = v_uid and provider = p_provider and label = v_label
   for update;

  if found and v_row.revoked_at is null and v_row.secret_ref is not null then
    -- Active row: rotate the existing Vault secret in place.
    perform vault.update_secret(v_row.secret_ref, p_secret);
    update public.user_connections
       set scopes = coalesce(p_scopes, '{}'),
           metadata = p_metadata,
           updated_at = now()
     where id = v_row.id
     returning * into v_row;
  elsif found then
    -- Revoked (or defensively: secret_ref-less) row for the same key:
    -- re-activate it with a fresh Vault secret.
    v_secret_id := vault.create_secret(
      p_secret,
      'user_connection:' || gen_random_uuid()::text,
      'user-provided ' || p_provider::text || ' credential'
    );
    update public.user_connections
       set secret_ref = v_secret_id,
           scopes = coalesce(p_scopes, '{}'),
           metadata = p_metadata,
           revoked_at = null,
           updated_at = now()
     where id = v_row.id
     returning * into v_row;
  else
    v_secret_id := vault.create_secret(
      p_secret,
      'user_connection:' || gen_random_uuid()::text,
      'user-provided ' || p_provider::text || ' credential'
    );
    insert into public.user_connections (user_id, provider, label, secret_ref, scopes, metadata)
    values (v_uid, p_provider, v_label, v_secret_id, coalesce(p_scopes, '{}'), p_metadata)
    returning * into v_row;
  end if;

  -- Never return the Vault reference (and never the secret, which is only
  -- ever written INTO Vault, never read back here).
  return to_jsonb(v_row) - 'secret_ref';
end;
$$;

comment on function public.store_user_connection(public.provider_kind, text, text, text[], jsonb) is
  'Create/rotate a user-scoped provider connection; the secret goes into Supabase Vault, the row stores only the reference. Prefer server-side (MCP backend) invocation; direct client invocation is v1-acceptable but the secret transits as an RPC argument — per-function log_statement opt-out is NOT installable on this hosted Postgres (SUSET parameter, permission denied), so project-level statement logging must stay off.';

-- ---------------------------------------------------------------------------
-- revoke_user_connection: delete the Vault secret and mark the row revoked.
--   * The row must exist AND belong to auth.uid() → else NOT_FOUND (a foreign
--     row is reported exactly like a missing one — no existence leak).
--   * Deletes the vault.secrets row, sets revoked_at, nulls secret_ref.
--   * Idempotent: revoking an already-revoked connection returns the row
--     unchanged, without error.
--   * Returns the row as jsonb minus secret_ref.
-- ---------------------------------------------------------------------------
create or replace function public.revoke_user_connection(
  p_connection_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.user_connections;
begin
  select * into v_row
    from public.user_connections
   where id = p_connection_id and user_id = v_uid
   for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  if v_row.revoked_at is not null then
    return to_jsonb(v_row) - 'secret_ref'; -- already revoked: no-op
  end if;

  if v_row.secret_ref is not null then
    delete from vault.secrets where id = v_row.secret_ref;
  end if;

  update public.user_connections
     set revoked_at = now(),
         secret_ref = null,
         updated_at = now()
   where id = v_row.id
   returning * into v_row;

  return to_jsonb(v_row) - 'secret_ref';
end;
$$;

comment on function public.revoke_user_connection(uuid) is
  'Revoke an own user connection: the Vault secret row is deleted, revoked_at set, secret_ref nulled. Idempotent; foreign/missing ids raise NOT_FOUND without revealing existence.';

-- ---------------------------------------------------------------------------
-- get_user_connection_secret: SERVICE ROLE ONLY decrypted credential read.
-- The MCP backend fetches the credential server-side at call time;
-- user-facing clients never read it back (execute is revoked from
-- authenticated/anon below). Active connection (revoked_at is null,
-- secret_ref not null) → decrypted secret; anything else → NOT_FOUND.
-- ---------------------------------------------------------------------------
create or replace function public.get_user_connection_secret(
  p_connection_id uuid
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_secret_ref uuid;
  v_secret text;
begin
  select uc.secret_ref into v_secret_ref
    from public.user_connections uc
   where uc.id = p_connection_id
     and uc.revoked_at is null
     and uc.secret_ref is not null;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select ds.decrypted_secret into v_secret
    from vault.decrypted_secrets ds
   where ds.id = v_secret_ref;
  if not found then
    raise exception 'NOT_FOUND'; -- reference dangling: treat as gone
  end if;

  return v_secret;
end;
$$;

comment on function public.get_user_connection_secret(uuid) is
  'SERVICE ROLE ONLY: returns the decrypted credential of an active user connection from Vault. User-facing clients must never be granted execute.';

-- Execution rights.
-- store/revoke: authenticated users (they operate on their own auth.uid())
-- and the service role; nothing for anon/public.
revoke execute on function public.store_user_connection(public.provider_kind, text, text, text[], jsonb) from public, anon;
revoke execute on function public.revoke_user_connection(uuid) from public, anon;
grant execute on function public.store_user_connection(public.provider_kind, text, text, text[], jsonb) to authenticated, service_role;
grant execute on function public.revoke_user_connection(uuid) to authenticated, service_role;

-- secret read-back: service role ONLY.
revoke execute on function public.get_user_connection_secret(uuid) from public, anon, authenticated;
grant execute on function public.get_user_connection_secret(uuid) to service_role;

-- Make PostgREST pick up the new RPCs immediately.
notify pgrst, 'reload schema';
