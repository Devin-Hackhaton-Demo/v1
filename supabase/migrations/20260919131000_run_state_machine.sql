-- 6 — run state machine: receipts table + service-role-only transition
-- functions (PROJECT_CONTEXT.md section 8).
--
-- Timing constants derived from section 8:
--   lease            90 seconds  (heartbeat cadence is 30 s, runner-side)
--   runtime cap     180 seconds  (enforced by the runner supervisor)
--   max attempts    2            (also a CHECK on runs.attempt)
--   approval window carried by approvals.expires_at (set at approval time)
--
-- All functions are SECURITY DEFINER and executable ONLY by service_role:
-- state transitions are never client-driven (section 14 RLS matrix). All
-- time comparisons use DB time now().

-- ---------------------------------------------------------------------------
-- run_receipts: idempotent closure receipts for complete/fail (section 8).
-- Key = (run_id, attempt_id, result_key) with the payload hash of the
-- reported closure; an identical retry gets the stored response verbatim,
-- a different payload for the same key is IDEMPOTENCY_CONFLICT.
-- RLS enabled with NO policies: clients see nothing; the service role
-- bypasses RLS and the SECURITY DEFINER functions read/write it.
-- ---------------------------------------------------------------------------
create table public.run_receipts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  run_id uuid not null,
  attempt_id uuid not null,
  result_key text not null check (char_length(result_key) between 1 and 200),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  response jsonb not null,
  created_at timestamptz not null default now(),
  unique (run_id, attempt_id, result_key),
  foreign key (run_id, project_id) references public.runs (id, project_id) on delete cascade
);

create index run_receipts_project_idx on public.run_receipts (project_id);

alter table public.run_receipts enable row level security;

-- ---------------------------------------------------------------------------
-- activate_due_runs: the worker tick. Everything is based on DB time now().
--   a. awaiting_approval + valid approval → 'scheduled' (future run_at)
--                                           or 'queued' (due/immediate)
--   b. scheduled + due + still-valid approval → 'queued'
--   c. awaiting_approval/scheduled/queued where an approval exists but none
--      is valid → 'blocked' + error_code 'APPROVAL_EXPIRED'
--      (runs with no approval at all stay put)
--   d. running with expired lease: attempt < 2 and valid approval → back to
--      'queued' (attempt count kept; the stale attempt_id/lease hash is
--      replaced at the next claim); otherwise → 'failed' with
--      error_code 'LEASE_EXPIRED' and the task → 'blocked'.
-- A valid approval = approvals row with subject 'run', matching run_id and
-- project, payload_hash equal to runs.payload_hash, not revoked, not expired.
-- Returns a jsonb summary of transition counts.
-- ---------------------------------------------------------------------------
create or replace function public.activate_due_runs()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scheduled integer := 0;
  v_queued integer := 0;
  v_blocked integer := 0;
  v_lease_requeued integer := 0;
  v_lease_failed integer := 0;
  v_count integer;
begin
  -- a. approved, future run_at → scheduled
  update public.runs r
     set state = 'scheduled'
   where r.state = 'awaiting_approval'
     and r.run_at is not null and r.run_at > now()
     and exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
          and a.payload_hash = r.payload_hash
          and a.revoked_at is null and a.expires_at > now()
     );
  get diagnostics v_scheduled = row_count;

  -- a. approved, immediate or already due → queued
  update public.runs r
     set state = 'queued'
   where r.state = 'awaiting_approval'
     and (r.run_at is null or r.run_at <= now())
     and exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
          and a.payload_hash = r.payload_hash
          and a.revoked_at is null and a.expires_at > now()
     );
  get diagnostics v_queued = row_count;

  -- b. scheduled runs that became due (approval still valid) → queued
  update public.runs r
     set state = 'queued'
   where r.state = 'scheduled'
     and r.run_at <= now()
     and exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
          and a.payload_hash = r.payload_hash
          and a.revoked_at is null and a.expires_at > now()
     );
  get diagnostics v_count = row_count;
  v_queued := v_queued + v_count;

  -- c. an approval exists but none is valid any more → blocked (section 8:
  --    an expired approval permanently blocks the run; a new prepare +
  --    approval is required). Runs with no approval at all stay put.
  update public.runs r
     set state = 'blocked', error_code = 'APPROVAL_EXPIRED'
   where r.state in ('awaiting_approval', 'scheduled', 'queued')
     and exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
     )
     and not exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
          and a.payload_hash = r.payload_hash
          and a.revoked_at is null and a.expires_at > now()
     );
  get diagnostics v_blocked = row_count;

  -- d. expired lease, attempts remain, approval still valid → requeue.
  --    The attempt count is kept; the stale attempt_id / lease token hash
  --    stay on the row and are replaced at the next claim (the old attempt
  --    is already excluded because state is no longer 'running' and the
  --    next claim rotates attempt_id + token).
  update public.runs r
     set state = 'queued'
   where r.state = 'running'
     and r.lease_expires_at < now()
     and r.attempt < 2
     and exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
          and a.payload_hash = r.payload_hash
          and a.revoked_at is null and a.expires_at > now()
     );
  get diagnostics v_lease_requeued = row_count;

  -- d. expired lease with no attempts left (or no valid approval) → failed,
  --    and the dependent task becomes blocked (section 8 task states).
  with failed as (
    update public.runs r
       set state = 'failed',
           error_code = 'LEASE_EXPIRED',
           finished_at = now()
     where r.state = 'running'
       and r.lease_expires_at < now()
       and (
         r.attempt >= 2
         or not exists (
           select 1 from public.approvals a
            where a.subject = 'run' and a.run_id = r.id and a.project_id = r.project_id
              and a.payload_hash = r.payload_hash
              and a.revoked_at is null and a.expires_at > now()
         )
       )
     returning r.id, r.task_id
  ), blocked_tasks as (
    update public.tasks t
       set status = 'blocked'
      from failed f
     where t.id = f.task_id
     returning t.id
  )
  select count(*) into v_lease_failed from failed;

  return jsonb_build_object(
    'scheduled', v_scheduled,
    'queued', v_queued,
    'blocked', v_blocked,
    'lease_requeued', v_lease_requeued,
    'lease_failed', v_lease_failed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- claim_run: atomic claim of the next queued run for a preset (section 8).
-- FOR UPDATE SKIP LOCKED guarantees that two concurrent claimers can never
-- get the same run. The plaintext lease token is returned exactly once;
-- only its SHA-256 hash is stored.
-- Returns {run, lease_token} or SQL null when nothing is claimable.
-- ---------------------------------------------------------------------------
create or replace function public.claim_run(p_preset public.task_kind default 'draft_brief')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.runs;
  v_token text;
begin
  select * into v_run
    from public.runs
   where state = 'queued' and preset = p_preset
   order by run_at nulls first, created_at
   limit 1
   for update skip locked;

  if not found then
    return null;
  end if;

  -- Defensive guard: a queued run must have attempts left (activate_due_runs
  -- fails such runs before they can be queued; this covers races).
  if v_run.attempt >= 2 then
    update public.runs
       set state = 'failed', error_code = 'LEASE_EXPIRED', finished_at = now()
     where id = v_run.id;
    update public.tasks set status = 'blocked' where id = v_run.task_id;
    return null;
  end if;

  -- Fresh random plaintext token; only its hash is persisted.
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  update public.runs
     set state = 'running',
         attempt = attempt + 1,
         attempt_id = gen_random_uuid(),
         lease_token_hash = encode(sha256(convert_to(v_token, 'utf8')), 'hex'),
         lease_expires_at = now() + interval '90 seconds',
         started_at = coalesce(started_at, now()),
         runner_last_seen_at = now()
   where id = v_run.id
   returning * into v_run;

  update public.tasks
     set status = 'running', latest_run_id = v_run.id
   where id = v_run.task_id;

  return jsonb_build_object('run', to_jsonb(v_run), 'lease_token', v_token);
end;
$$;

-- ---------------------------------------------------------------------------
-- heartbeat_run: extend a live lease (section 8; runner heartbeats every
-- 30 s against the 90 s lease). Requires the exact running attempt and the
-- plaintext token whose hash is stored; anything else is LEASE_EXPIRED.
-- Returns {lease_expires_at}.
-- ---------------------------------------------------------------------------
create or replace function public.heartbeat_run(
  p_run_id uuid,
  p_attempt_id uuid,
  p_lease_token text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.runs;
  v_expires timestamptz;
begin
  select * into v_run from public.runs where id = p_run_id for update;

  if not found
     or v_run.state <> 'running'
     or v_run.attempt_id is distinct from p_attempt_id
     or v_run.lease_token_hash is distinct from encode(sha256(convert_to(p_lease_token, 'utf8')), 'hex')
     or v_run.lease_expires_at is null
     or v_run.lease_expires_at <= now() then
    raise exception 'LEASE_EXPIRED';
  end if;

  update public.runs
     set lease_expires_at = now() + interval '90 seconds',
         runner_last_seen_at = now()
   where id = p_run_id
   returning lease_expires_at into v_expires;

  return jsonb_build_object('lease_expires_at', v_expires);
end;
$$;

-- ---------------------------------------------------------------------------
-- complete_run: receipt-based idempotent successful closure (section 8).
--   1. Lock the run.
--   2. Receipt lookup by (run_id, attempt_id, result_key): identical
--      payload_hash → return the stored response AS-IS (even if the lease
--      has since expired or the state moved on — an identical retry gets
--      the identical receipt); different payload_hash → IDEMPOTENCY_CONFLICT.
--   3. A NEW closure requires a live lease: state 'running', matching
--      attempt_id, matching token hash, unexpired lease → else LEASE_EXPIRED.
--   4. One transaction: insert the artifacts row, mark the run 'succeeded',
--      mark the task 'done', store the receipt.
-- p_artifact = {file_name, mime_type, size_bytes, sha256, storage_path}.
-- NOTE: the service caller must upload the artifact BYTES to the private
-- 'artifacts' Storage bucket (project_id/artifact_id path convention) and
-- verify the SHA-256 BEFORE calling this function — this function records
-- metadata only and cannot see Storage.
-- Returns {state:'succeeded', run_id, attempt_id, result_key, artifact_id,
-- checks} — the same jsonb that is stored as the receipt response.
-- ---------------------------------------------------------------------------
create or replace function public.complete_run(
  p_run_id uuid,
  p_attempt_id uuid,
  p_lease_token text,
  p_result_key text,
  p_payload_hash text,
  p_artifact jsonb,
  p_checks jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.runs;
  v_receipt public.run_receipts;
  v_artifact public.artifacts;
  v_response jsonb;
begin
  select * into v_run from public.runs where id = p_run_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_receipt
    from public.run_receipts
   where run_id = p_run_id and attempt_id = p_attempt_id and result_key = p_result_key;
  if found then
    if v_receipt.payload_hash = p_payload_hash then
      return v_receipt.response; -- identical retry → identical receipt
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT';
  end if;

  if v_run.state <> 'running'
     or v_run.attempt_id is distinct from p_attempt_id
     or v_run.lease_token_hash is distinct from encode(sha256(convert_to(p_lease_token, 'utf8')), 'hex')
     or v_run.lease_expires_at is null
     or v_run.lease_expires_at <= now() then
    raise exception 'LEASE_EXPIRED';
  end if;

  insert into public.artifacts (
    project_id, run_id, file_name, mime_type, size_bytes, sha256, storage_path
  ) values (
    v_run.project_id,
    v_run.id,
    p_artifact->>'file_name',
    p_artifact->>'mime_type',
    (p_artifact->>'size_bytes')::integer,
    p_artifact->>'sha256',
    p_artifact->>'storage_path'
  ) returning * into v_artifact;

  update public.runs
     set state = 'succeeded',
         result_artifact_id = v_artifact.id,
         checks = p_checks,
         finished_at = now()
   where id = v_run.id;

  update public.tasks set status = 'done' where id = v_run.task_id;

  v_response := jsonb_build_object(
    'state', 'succeeded',
    'run_id', v_run.id,
    'attempt_id', p_attempt_id,
    'result_key', p_result_key,
    'artifact_id', v_artifact.id,
    'checks', p_checks
  );

  insert into public.run_receipts (
    project_id, run_id, attempt_id, result_key, payload_hash, response
  ) values (
    v_run.project_id, v_run.id, p_attempt_id, p_result_key, p_payload_hash, v_response
  );

  return v_response;
end;
$$;

-- ---------------------------------------------------------------------------
-- fail_run: receipt-based idempotent failure closure (section 8). Same
-- receipt lookup/conflict logic and live-lease requirement as complete_run.
-- New closure: retryable + attempts left + valid approval → 'queued' (a
-- fresh attempt at the next claim); otherwise 'failed' + task 'blocked'.
-- p_safe_message is assumed already sanitized by the service caller (no
-- secrets, no raw provider errors — section 6).
-- Returns {state, run_id, attempt_id, result_key, error_code}.
-- ---------------------------------------------------------------------------
create or replace function public.fail_run(
  p_run_id uuid,
  p_attempt_id uuid,
  p_lease_token text,
  p_result_key text,
  p_error_code text,
  p_safe_message text,
  p_retryable boolean default false
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.runs;
  v_receipt public.run_receipts;
  v_payload_hash text;
  v_state text;
  v_response jsonb;
begin
  -- The failure payload fingerprint is derived here deterministically (the
  -- signature carries no client hash): an identical retry produces the same
  -- hash, a different failure report for the same result_key conflicts.
  v_payload_hash := encode(
    sha256(convert_to(
      p_error_code || E'\n' || p_safe_message || E'\n' || p_retryable::text,
      'utf8'
    )),
    'hex'
  );

  select * into v_run from public.runs where id = p_run_id for update;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_receipt
    from public.run_receipts
   where run_id = p_run_id and attempt_id = p_attempt_id and result_key = p_result_key;
  if found then
    if v_receipt.payload_hash = v_payload_hash then
      return v_receipt.response; -- identical retry → identical receipt
    end if;
    raise exception 'IDEMPOTENCY_CONFLICT';
  end if;

  if v_run.state <> 'running'
     or v_run.attempt_id is distinct from p_attempt_id
     or v_run.lease_token_hash is distinct from encode(sha256(convert_to(p_lease_token, 'utf8')), 'hex')
     or v_run.lease_expires_at is null
     or v_run.lease_expires_at <= now() then
    raise exception 'LEASE_EXPIRED';
  end if;

  if p_retryable
     and v_run.attempt < 2
     and exists (
       select 1 from public.approvals a
        where a.subject = 'run' and a.run_id = v_run.id and a.project_id = v_run.project_id
          and a.payload_hash = v_run.payload_hash
          and a.revoked_at is null and a.expires_at > now()
     ) then
    v_state := 'queued';
    update public.runs
       set state = 'queued',
           error_code = p_error_code,
           error_message = p_safe_message
     where id = v_run.id;
  else
    v_state := 'failed';
    update public.runs
       set state = 'failed',
           error_code = p_error_code,
           error_message = p_safe_message,
           finished_at = now()
     where id = v_run.id;
    update public.tasks set status = 'blocked' where id = v_run.task_id;
  end if;

  v_response := jsonb_build_object(
    'state', v_state,
    'run_id', v_run.id,
    'attempt_id', p_attempt_id,
    'result_key', p_result_key,
    'error_code', p_error_code
  );

  insert into public.run_receipts (
    project_id, run_id, attempt_id, result_key, payload_hash, response
  ) values (
    v_run.project_id, v_run.id, p_attempt_id, p_result_key, v_payload_hash, v_response
  );

  return v_response;
end;
$$;

-- Execution rights: state transitions are service-only (section 14 matrix);
-- clients never call these.
revoke execute on function public.activate_due_runs() from public, anon, authenticated;
revoke execute on function public.claim_run(public.task_kind) from public, anon, authenticated;
revoke execute on function public.heartbeat_run(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.complete_run(uuid, uuid, text, text, text, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.fail_run(uuid, uuid, text, text, text, text, boolean) from public, anon, authenticated;
grant execute on function public.activate_due_runs() to service_role;
grant execute on function public.claim_run(public.task_kind) to service_role;
grant execute on function public.heartbeat_run(uuid, uuid, text) to service_role;
grant execute on function public.complete_run(uuid, uuid, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_run(uuid, uuid, text, text, text, text, boolean) to service_role;
