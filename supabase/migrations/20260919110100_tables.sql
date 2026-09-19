-- 2/4 — A 13 logikai entitás táblái (PROJECT_CONTEXT.md §5).
-- Minden üzleti rekord project_id-hoz kötött; a "kapcsolódó FK ugyanabba a
-- projektbe mutasson" szabályt kompozit FK-k (id, project_id) kényszerítik ki.

-- Számok levezetése (§4, §6):
--   submitted_text  ≤ 64 KiB = 65 536 bájt
--   summary         ≤  8 KiB =  8 192 bájt
--   artifact méret  ≤  1 MiB = 1 048 576 bájt
-- Az 5 fájl/mentés és 20 MiB/projekt limit a connector rétegben érvényesül.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 200),
  context_revision integer not null default 0 check (context_revision >= 0),
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now()
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role public.membership_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (project_id, user_id)
);

create index memberships_user_idx on public.memberships (user_id);

-- Artifact: metaadat + Supabase Storage útvonal; a bájtok a privát
-- 'artifacts' bucketben élnek (project_id/artifact_id/fájlnév).
create table public.artifacts (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  run_id uuid, -- FK a runs tábla létrejötte után (lásd lent)
  file_name text not null check (char_length(file_name) between 1 and 255),
  mime_type text not null check (mime_type in ('text/plain', 'text/markdown', 'application/json')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 1048576),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text not null unique,
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, project_id)
);

create index artifacts_project_idx on public.artifacts (project_id);

create table public.context_entries (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  revision integer not null,
  source_kind public.source_kind not null,
  source_label text not null check (char_length(source_label) between 1 and 300),
  conversation_ref text,
  occurred_at timestamptz,
  coverage public.coverage_kind not null,
  submitted_text text check (octet_length(submitted_text) <= 65536),
  summary text not null check (octet_length(summary) between 1 and 8192),
  full_text_artifact_id uuid,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references auth.users (id) default auth.uid(),
  saved_at timestamptz not null default now(),
  unique (id, project_id),
  unique (project_id, revision),
  foreign key (full_text_artifact_id, project_id)
    references public.artifacts (id, project_id),
  -- supplied_export ⇔ van export artifact; máskor tilos (§6 full_text_file_ref)
  constraint context_full_text_matches_coverage check (
    (coverage = 'supplied_export') = (full_text_artifact_id is not null)
  )
);

create index context_entries_project_idx on public.context_entries (project_id, revision desc);

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  context_entry_id uuid not null,
  key text not null check (char_length(key) between 1 and 200),
  -- §6: value string, number vagy boolean
  value jsonb not null check (jsonb_typeof(value) in ('string', 'number', 'boolean')),
  source_excerpt text check (octet_length(source_excerpt) <= 8192),
  supersedes_decision_ids uuid[] not null default '{}',
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (context_entry_id, project_id)
    references public.context_entries (id, project_id) on delete cascade
);

create index decisions_project_key_idx on public.decisions (project_id, key);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  context_entry_id uuid,
  title text not null check (char_length(title) between 1 and 300),
  kind public.task_kind not null default 'draft_brief',
  required_decision_keys text[] not null default '{}',
  input_artifact_ids uuid[] not null default '{}',
  status public.task_status not null default 'open',
  latest_run_id uuid, -- FK a runs tábla után
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (context_entry_id, project_id)
    references public.context_entries (id, project_id)
);

create index tasks_project_status_idx on public.tasks (project_id, status);

create table public.connections (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  kind public.connection_kind not null default 'github',
  target_repo text not null check (target_repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  -- Csak titoktári hivatkozás (§7); token soha nem kerül DB-be.
  secret_ref text not null check (char_length(secret_ref) between 1 and 300),
  allowed_presets public.task_kind[] not null default '{draft_brief}',
  created_by uuid references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (id, project_id)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  task_id uuid not null,
  state public.run_state not null default 'awaiting_approval',
  preset public.task_kind not null default 'draft_brief',
  preset_version text not null default 'v1',
  validator_version text not null default 'v1',
  context_revision integer not null check (context_revision >= 0),
  context_entry_ids uuid[] not null default '{}',
  snapshot_hash text check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  payload_hash text check (payload_hash ~ '^[0-9a-f]{64}$'),
  run_at timestamptz,
  -- §8: legfeljebb 2 próbálkozás
  attempt integer not null default 0 check (attempt between 0 and 2),
  attempt_id uuid,
  lease_token_hash text,
  lease_expires_at timestamptz,
  runner_last_seen_at timestamptz,
  result_artifact_id uuid,
  checks jsonb,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (task_id, project_id) references public.tasks (id, project_id),
  foreign key (result_artifact_id, project_id) references public.artifacts (id, project_id)
);

-- §6: egy taskhoz egyszerre egy aktív run.
create unique index runs_one_active_per_task_idx on public.runs (task_id)
  where state in ('awaiting_approval', 'scheduled', 'queued', 'running');

-- Worker-polling: esedékes, jóváhagyott futások.
create index runs_due_idx on public.runs (state, run_at);
create index runs_project_idx on public.runs (project_id, created_at desc);

alter table public.artifacts
  add constraint artifacts_run_fk
  foreign key (run_id, project_id) references public.runs (id, project_id);

alter table public.tasks
  add constraint tasks_latest_run_fk
  foreign key (latest_run_id, project_id) references public.runs (id, project_id);

create table public.external_actions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  kind public.action_kind not null default 'github_issue_create',
  run_id uuid not null,
  artifact_id uuid not null,
  connection_id uuid not null,
  repo text not null check (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),
  title text not null check (char_length(title) between 1 and 300),
  body text not null check (octet_length(body) <= 65536),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  state public.action_state not null default 'awaiting_approval',
  external_id text,
  external_url text,
  verified_at timestamptz,
  error_code text,
  error_message text,
  created_by uuid not null references auth.users (id) default auth.uid(),
  created_at timestamptz not null default now(),
  unique (id, project_id),
  foreign key (run_id, project_id) references public.runs (id, project_id),
  foreign key (artifact_id, project_id) references public.artifacts (id, project_id),
  foreign key (connection_id, project_id) references public.connections (id, project_id)
);

create index external_actions_project_state_idx on public.external_actions (project_id, state);

create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  subject public.approval_subject not null,
  run_id uuid,
  action_id uuid,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  run_at timestamptz,
  approved_by uuid not null references auth.users (id) default auth.uid(),
  approved_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  consumed_at timestamptz,
  unique (id, project_id),
  foreign key (run_id, project_id) references public.runs (id, project_id),
  foreign key (action_id, project_id) references public.external_actions (id, project_id),
  constraint approvals_subject_target check (
    (subject = 'run' and run_id is not null and action_id is null)
    or (subject = 'external_action' and action_id is not null and run_id is null)
  )
);

create index approvals_project_idx on public.approvals (project_id, approved_at desc);

create table public.runner_identities (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  allowed_presets public.task_kind[] not null default '{draft_brief}',
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  project_id uuid references public.projects (id) on delete set null,
  actor_kind text not null check (actor_kind in ('user', 'service', 'runner')),
  actor_id text,
  action text not null check (char_length(action) between 1 and 200),
  target_kind text,
  target_id text,
  request_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);

create index audit_events_project_idx on public.audit_events (project_id, created_at desc);

-- §6: egyediség szereplő + projekt + eszköz + kulcs szerint.
create table public.idempotency_records (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  actor_id uuid not null,
  tool text not null check (char_length(tool) between 1 and 100),
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  result jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, actor_id, tool, idempotency_key)
);
