-- 5 — save_context and prepare_run RPCs (SECURITY INVOKER).
--
-- Why: the previous client-side saveContext helper performed three separate
-- statements (entry, decisions, tasks); an interrupted batch could leave an
-- orphan context entry with an already-bumped project revision
-- (PROJECT_CONTEXT.md section 14, open item "transactionality"). A plpgsql
-- function body runs in a single transaction, so any raised exception rolls
-- back the whole batch.
--
-- SECURITY INVOKER on purpose: RLS keeps enforcing every row rule inside the
-- function (member-only inserts, awaiting_approval-only run INSERT, the
-- revision trigger, immutability triggers). The functions only add atomicity
-- and the cross-row validations, no privilege escalation.
--
-- Error contract (PROJECT_CONTEXT.md section 6): foreign/unknown project or
-- task raises 'NOT_FOUND' without revealing existence; input problems raise
-- 'VALIDATION_ERROR: <short safe detail>'; decision-gate problems raise
-- 'DECISION_CONFLICT: <key>' / 'CONTEXT_INCOMPLETE: <key>'.

-- ---------------------------------------------------------------------------
-- save_context: one atomic batch = context entry + decisions + tasks.
--   p_source:    {kind, label, conversation_ref?, occurred_at?}
--   p_decisions: [{key, value, source_excerpt?, supersedes_decision_ids?}]
--                (value must be a JSON string/number/boolean — the decisions
--                table CHECK enforces it and the raise rolls back the batch)
--   p_tasks:     [{title, required_decision_keys?, input_artifact_ids?}]
-- Returns: {entry, decisions: [...], tasks: [...], context_revision}.
-- The revision trigger fills entry.revision and bumps the project revision
-- atomically; content_hash is computed by the TypeScript layer.
-- ---------------------------------------------------------------------------
create or replace function public.save_context(
  p_project_id uuid,
  p_source jsonb,
  p_coverage public.coverage_kind,
  p_summary text,
  p_content_hash text,
  p_submitted_text text default null,
  p_full_text_artifact_id uuid default null,
  p_decisions jsonb default '[]'::jsonb,
  p_tasks jsonb default '[]'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_entry public.context_entries;
  v_decision public.decisions;
  v_task public.tasks;
  v_decisions jsonb := '[]'::jsonb;
  v_tasks jsonb := '[]'::jsonb;
  v_item jsonb;
begin
  -- Do not reveal whether the project exists (section 6: NOT_FOUND).
  if not public.is_project_member(p_project_id) then
    raise exception 'NOT_FOUND';
  end if;

  insert into public.context_entries (
    project_id, source_kind, source_label, conversation_ref, occurred_at,
    coverage, submitted_text, summary, full_text_artifact_id, content_hash
  ) values (
    p_project_id,
    (p_source->>'kind')::public.source_kind,
    p_source->>'label',
    p_source->>'conversation_ref',
    (p_source->>'occurred_at')::timestamptz,
    p_coverage,
    p_submitted_text,
    p_summary,
    p_full_text_artifact_id,
    p_content_hash
  ) returning * into v_entry;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_decisions, '[]'::jsonb)) with ordinality as e(value, ord)
    order by e.ord
  loop
    insert into public.decisions (
      project_id, context_entry_id, key, value, source_excerpt, supersedes_decision_ids
    ) values (
      p_project_id,
      v_entry.id,
      v_item->>'key',
      v_item->'value', -- table CHECK enforces string/number/boolean
      v_item->>'source_excerpt',
      coalesce(
        (select array_agg(x.val::uuid)
           from jsonb_array_elements_text(v_item->'supersedes_decision_ids') as x(val)),
        '{}'::uuid[]
      )
    ) returning * into v_decision;
    v_decisions := v_decisions || to_jsonb(v_decision);
  end loop;

  for v_item in
    select value from jsonb_array_elements(coalesce(p_tasks, '[]'::jsonb)) with ordinality as e(value, ord)
    order by e.ord
  loop
    insert into public.tasks (
      project_id, context_entry_id, title, required_decision_keys, input_artifact_ids
    ) values (
      p_project_id,
      v_entry.id,
      v_item->>'title',
      coalesce(
        (select array_agg(x.val)
           from jsonb_array_elements_text(v_item->'required_decision_keys') as x(val)),
        '{}'::text[]
      ),
      coalesce(
        (select array_agg(x.val::uuid)
           from jsonb_array_elements_text(v_item->'input_artifact_ids') as x(val)),
        '{}'::uuid[]
      )
    ) returning * into v_task;
    v_tasks := v_tasks || to_jsonb(v_task);
  end loop;

  return jsonb_build_object(
    'entry', to_jsonb(v_entry),
    'decisions', v_decisions,
    'tasks', v_tasks,
    'context_revision', v_entry.revision
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- prepare_run: validated run_prepare (section 6) in one transaction.
-- Validations:
--   * caller is a member, task belongs to this project → else NOT_FOUND
--   * p_context_revision <= projects.context_revision and every selected
--     entry exists in this project with revision <= p_context_revision
--   * p_run_at is null, or at most 24 hours ahead (section 8) and not in the
--     past by more than 10 seconds (small grace for client clock skew)
--   * decision gate (section 5): every required key of the task must resolve
--     to exactly one distinct non-superseded value among the SELECTED entries
--     (superseding decisions count only when they are selected themselves);
--     >1 value → DECISION_CONFLICT, 0 values → CONTEXT_INCOMPLETE
--   * hashes are computed by the TypeScript domain layer (RFC 8785 canonical
--     JSON cannot be reproduced reliably in plpgsql); here only their
--     '^[0-9a-f]{64}$' shape is validated when not null
-- Inserts the run in the default 'awaiting_approval' state — the existing
-- RLS insert policy still applies because this is SECURITY INVOKER.
-- Returns the full run row as jsonb.
-- ---------------------------------------------------------------------------
create or replace function public.prepare_run(
  p_project_id uuid,
  p_task_id uuid,
  p_context_revision integer,
  p_context_entry_ids uuid[],
  p_payload_hash text,
  p_snapshot_hash text default null,
  p_run_at timestamptz default null
) returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_task public.tasks;
  v_project_revision integer;
  v_bad_entries integer;
  v_key text;
  v_value_count integer;
  v_run public.runs;
begin
  if not public.is_project_member(p_project_id) then
    raise exception 'NOT_FOUND';
  end if;

  select * into v_task
    from public.tasks
   where id = p_task_id and project_id = p_project_id;
  if not found then
    raise exception 'NOT_FOUND';
  end if;

  if p_payload_hash is not null and p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'VALIDATION_ERROR: payload_hash must be 64 lowercase hex characters';
  end if;
  if p_snapshot_hash is not null and p_snapshot_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'VALIDATION_ERROR: snapshot_hash must be 64 lowercase hex characters';
  end if;

  select context_revision into v_project_revision
    from public.projects
   where id = p_project_id;
  if p_context_revision is null or p_context_revision < 0
     or p_context_revision > v_project_revision then
    raise exception 'VALIDATION_ERROR: context_revision % is not a valid project revision',
      p_context_revision;
  end if;

  select count(*) into v_bad_entries
    from unnest(coalesce(p_context_entry_ids, '{}'::uuid[])) as sel(id)
   where not exists (
     select 1
       from public.context_entries ce
      where ce.id = sel.id
        and ce.project_id = p_project_id
        and ce.revision <= p_context_revision
   );
  if v_bad_entries > 0 then
    raise exception 'VALIDATION_ERROR: % selected context entries are missing from this project or newer than the pinned revision',
      v_bad_entries;
  end if;

  -- Section 8: run_at may point at most 24 hours ahead; 10 seconds of grace
  -- toward the past covers client clock skew without accepting stale times.
  if p_run_at is not null
     and (p_run_at > now() + interval '24 hours'
          or p_run_at < now() - interval '10 seconds') then
    raise exception 'VALIDATION_ERROR: run_at out of range';
  end if;

  -- Decision gate over the SELECTED entries only (section 5).
  foreach v_key in array v_task.required_decision_keys loop
    select count(distinct d.value) into v_value_count
      from public.decisions d
     where d.project_id = p_project_id
       and d.context_entry_id = any(coalesce(p_context_entry_ids, '{}'::uuid[]))
       and d.key = v_key
       and not exists (
         select 1
           from public.decisions s
          where s.project_id = p_project_id
            and s.context_entry_id = any(coalesce(p_context_entry_ids, '{}'::uuid[]))
            and d.id = any(s.supersedes_decision_ids)
       );
    if v_value_count > 1 then
      raise exception 'DECISION_CONFLICT: %', v_key;
    elsif v_value_count = 0 then
      raise exception 'CONTEXT_INCOMPLETE: %', v_key;
    end if;
  end loop;

  insert into public.runs (
    project_id, task_id, context_revision, context_entry_ids,
    payload_hash, snapshot_hash, run_at
  ) values (
    p_project_id, p_task_id, p_context_revision,
    coalesce(p_context_entry_ids, '{}'::uuid[]),
    p_payload_hash, p_snapshot_hash, p_run_at
  ) returning * into v_run;

  return to_jsonb(v_run);
end;
$$;

-- Execution rights: authenticated members (RLS still decides row access
-- inside) and the service role; nothing for anon/public.
revoke execute on function public.save_context(uuid, jsonb, public.coverage_kind, text, text, text, uuid, jsonb, jsonb) from public, anon;
revoke execute on function public.prepare_run(uuid, uuid, integer, uuid[], text, text, timestamptz) from public, anon;
grant execute on function public.save_context(uuid, jsonb, public.coverage_kind, text, text, text, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.prepare_run(uuid, uuid, integer, uuid[], text, text, timestamptz) to authenticated, service_role;
