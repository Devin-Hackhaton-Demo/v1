-- 4/4 — RLS-szabályok (PROJECT_CONTEXT.md §5–§7 mátrix) + privát Storage bucket.
--
-- Mátrix:
--   member  → minden olvasás a saját projektben; írás: context_entries,
--             decisions, tasks, artifacts; runs/external_actions INSERT
--             kizárólag 'awaiting_approval' állapotban (= prepare).
--   owner   → plusz approvals, connections, memberships kezelése.
--   service → állapotátmenetek (runs, external_actions), audit_events,
--             idempotency_records, runner_identities (a service_role
--             megkerüli az RLS-t, külön policy nem kell neki).
-- Idegen projekt: se adat, se létezésinformáció (NOT_FOUND-viselkedés).

alter table public.projects enable row level security;
alter table public.memberships enable row level security;
alter table public.context_entries enable row level security;
alter table public.decisions enable row level security;
alter table public.tasks enable row level security;
alter table public.artifacts enable row level security;
alter table public.runs enable row level security;
alter table public.external_actions enable row level security;
alter table public.approvals enable row level security;
alter table public.connections enable row level security;
alter table public.runner_identities enable row level security;
alter table public.audit_events enable row level security;
alter table public.idempotency_records enable row level security;

-- projects: tag olvashat; létrehozni bárki bejelentkezett tud (trigger
-- teszi ownerré); UPDATE/DELETE csak service (revízió-manipuláció tiltva).
create policy projects_select on public.projects
  for select to authenticated
  using (public.is_project_member(id));

create policy projects_insert on public.projects
  for insert to authenticated
  with check (created_by = (select auth.uid()));

-- memberships: tag látja a projektje tagságait; kezelni csak owner tud.
create policy memberships_select on public.memberships
  for select to authenticated
  using (public.is_project_member(project_id));

create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (public.is_project_owner(project_id));

create policy memberships_update on public.memberships
  for update to authenticated
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id));

create policy memberships_delete on public.memberships
  for delete to authenticated
  using (public.is_project_owner(project_id));

-- context_entries: tag olvas és ment; UPDATE/DELETE nincs (immutábilis).
create policy context_entries_select on public.context_entries
  for select to authenticated
  using (public.is_project_member(project_id));

create policy context_entries_insert on public.context_entries
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and created_by = (select auth.uid())
  );

-- decisions: mint a context_entries.
create policy decisions_select on public.decisions
  for select to authenticated
  using (public.is_project_member(project_id));

create policy decisions_insert on public.decisions
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and created_by = (select auth.uid())
  );

-- tasks: tag olvas és létrehoz; állapotátmenet (running/done/blocked,
-- latest_run_id) csak service.
create policy tasks_select on public.tasks
  for select to authenticated
  using (public.is_project_member(project_id));

create policy tasks_insert on public.tasks
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and created_by = (select auth.uid())
    and status = 'open'
    and latest_run_id is null
  );

-- artifacts: tag olvas és feltölt (metaadat); módosítás/törlés csak service.
create policy artifacts_select on public.artifacts
  for select to authenticated
  using (public.is_project_member(project_id));

create policy artifacts_insert on public.artifacts
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and created_by = (select auth.uid())
    and run_id is null -- futási eredményt csak a service írhat
  );

-- runs: tag olvas; run_prepare = INSERT kizárólag awaiting_approval
-- állapotban, kitöltött lease/eredmény mezők nélkül. Átmenetek: service.
create policy runs_select on public.runs
  for select to authenticated
  using (public.is_project_member(project_id));

create policy runs_insert on public.runs
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and created_by = (select auth.uid())
    and state = 'awaiting_approval'
    and attempt = 0
    and attempt_id is null
    and lease_token_hash is null
    and result_artifact_id is null
    and started_at is null
    and finished_at is null
  );

-- external_actions: tag olvas; github_issue_prepare = INSERT awaiting_approval
-- állapotban, külső eredménymezők nélkül. Végrehajtás: service.
create policy external_actions_select on public.external_actions
  for select to authenticated
  using (public.is_project_member(project_id));

create policy external_actions_insert on public.external_actions
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and created_by = (select auth.uid())
    and state = 'awaiting_approval'
    and external_id is null
    and external_url is null
    and verified_at is null
  );

-- approvals: tag olvashatja (státusz visszaolvasás); csak owner hozhat
-- létre a saját nevében; visszavonás (update) is owner.
create policy approvals_select on public.approvals
  for select to authenticated
  using (public.is_project_member(project_id));

create policy approvals_insert on public.approvals
  for insert to authenticated
  with check (
    public.is_project_owner(project_id)
    and approved_by = (select auth.uid())
  );

create policy approvals_update on public.approvals
  for update to authenticated
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id));

-- connections: tag olvas (kell a prepare-hez); kezelés owner.
create policy connections_select on public.connections
  for select to authenticated
  using (public.is_project_member(project_id));

create policy connections_insert on public.connections
  for insert to authenticated
  with check (public.is_project_owner(project_id));

create policy connections_update on public.connections
  for update to authenticated
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id));

-- runner_identities: csak owner láthatja; írás csak service.
create policy runner_identities_select on public.runner_identities
  for select to authenticated
  using (public.is_project_owner(project_id));

-- audit_events: tag olvashatja a projektje eseményeit; írás csak service.
create policy audit_events_select on public.audit_events
  for select to authenticated
  using (project_id is not null and public.is_project_member(project_id));

-- idempotency_records: a szereplő a sajátját olvassa/írja a projektjében.
create policy idempotency_select on public.idempotency_records
  for select to authenticated
  using (
    public.is_project_member(project_id)
    and actor_id = (select auth.uid())
  );

create policy idempotency_insert on public.idempotency_records
  for insert to authenticated
  with check (
    public.is_project_member(project_id)
    and actor_id = (select auth.uid())
  );

-- Privát Storage bucket az artifact bájtoknak.
-- Útvonal-konvenció: <project_id>/<artifact_id>/<fájlnév>
insert into storage.buckets (id, name, public)
values ('artifacts', 'artifacts', false)
on conflict (id) do nothing;

create policy artifacts_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'artifacts'
    and public.is_project_member(((storage.foldername(name))[1])::uuid)
  );

create policy artifacts_storage_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'artifacts'
    and public.is_project_member(((storage.foldername(name))[1])::uuid)
  );
