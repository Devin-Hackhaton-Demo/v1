-- 3/4 — Függvények és triggerek: revíziószámozás, auto-membership,
-- mentések változtathatatlansága, RLS-segédfüggvények.

-- Tagság-ellenőrzés az RLS-hez. SECURITY DEFINER: a memberships tábla
-- RLS-e nélkül, rekurzió nélkül fut.
create or replace function public.is_project_member(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.project_id = p_project_id
      and m.user_id = (select auth.uid())
  );
$$;

create or replace function public.is_project_owner(p_project_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    where m.project_id = p_project_id
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

revoke execute on function public.is_project_member(uuid) from public, anon;
revoke execute on function public.is_project_owner(uuid) from public, anon;
grant execute on function public.is_project_member(uuid) to authenticated, service_role;
grant execute on function public.is_project_owner(uuid) to authenticated, service_role;

-- §5: a kontextusmentés atomikusan lépteti a projekt revízióját.
-- A projekt sorának UPDATE-je sorzárol, így párhuzamos mentésnél sincs
-- duplikált vagy kihagyott revízió. SECURITY DEFINER: a tagnak nincs
-- UPDATE joga a projects táblán, a trigger mégis léptethet.
create or replace function public.assign_context_revision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revision integer;
begin
  update public.projects
     set context_revision = context_revision + 1
   where id = new.project_id
  returning context_revision into v_revision;

  if v_revision is null then
    raise exception 'project % not found', new.project_id;
  end if;

  new.revision := v_revision;
  new.saved_at := now();
  return new;
end;
$$;

create trigger context_entries_assign_revision
  before insert on public.context_entries
  for each row
  execute function public.assign_context_revision();

-- Projekt létrehozója automatikusan owner tag lesz.
create or replace function public.handle_new_project()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.created_by is not null then
    insert into public.memberships (project_id, user_id, role)
    values (new.id, new.created_by, 'owner')
    on conflict (project_id, user_id) do update set role = 'owner';
  end if;
  return new;
end;
$$;

create trigger projects_auto_owner_membership
  after insert on public.projects
  for each row
  execute function public.handle_new_project();

-- §5: a mentések változatlanok — javítás új bejegyzéssel és
-- supersedes_decision_ids-szel történik. UPDATE mindenkinek tilos
-- (a service role-nak is); DELETE-et az RLS tiltja a klienseknek,
-- a service role takarításhoz megtarthatja.
create or replace function public.forbid_update()
returns trigger
language plpgsql
as $$
begin
  raise exception '% rows are immutable; create a superseding entry instead', tg_table_name
    using errcode = 'raise_exception';
end;
$$;

create trigger context_entries_immutable
  before update on public.context_entries
  for each row
  execute function public.forbid_update();

create trigger decisions_immutable
  before update on public.decisions
  for each row
  execute function public.forbid_update();
