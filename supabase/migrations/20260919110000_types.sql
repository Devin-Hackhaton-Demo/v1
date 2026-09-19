-- 1/4 — Enum típusok a PROJECT_CONTEXT.md §5 adatmodellje szerint.

create type public.membership_role as enum ('owner', 'member');

create type public.source_kind as enum ('chatgpt', 'manual_import');

create type public.coverage_kind as enum ('summary_only', 'partial_text', 'supplied_export');

create type public.task_kind as enum ('draft_brief');

create type public.task_status as enum ('open', 'running', 'done', 'blocked');

-- §8: awaiting_approval → scheduled → queued → running → succeeded | failed;
-- nem futó állapotból cancelled, lejárt engedélynél blocked.
create type public.run_state as enum (
  'awaiting_approval', 'scheduled', 'queued', 'running',
  'succeeded', 'failed', 'cancelled', 'blocked'
);

-- §9: awaiting_approval → queued → executing → succeeded | failed | outcome_unknown;
-- indulás előtt cancelled, jogosultságvesztésnél blocked.
create type public.action_state as enum (
  'awaiting_approval', 'queued', 'executing',
  'succeeded', 'failed', 'outcome_unknown', 'cancelled', 'blocked'
);

create type public.action_kind as enum ('github_issue_create');

create type public.connection_kind as enum ('github');

create type public.approval_subject as enum ('run', 'external_action');
