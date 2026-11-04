-- MCQ revision upgrade, additive migration (2026-11-02).
-- Run in Supabase SQL Editor as the project owner, after the original schema.
-- Retains all existing sync records, including historical Daily 10 data.
-- Update the frontend together with this migration: sync_push now requires base_updated_at;
-- sync_pull cursors are server revisions. Old timestamp cursors must be reset client-side.
-- No content or historical rows are deleted. Rollback requires the previous RPC definitions
-- and previous frontend together; do not drop the new revision column or its sequence.

create or replace function public.sets_before_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.owner := auth.uid();
  new.status := 'approved';
  new.star_count := 0;
  new.report_count := 0;
  new.created_at := now();
  if new.file_path is distinct from (auth.uid()::text || '/' || new.id::text || '/pack.zip') then
    raise exception 'file_path must be <your user id>/<set id>/pack.zip';
  end if;
  if new.cover_path is not null and new.cover_path not like (auth.uid()::text || '/' || new.id::text || '/cover.%') then
    raise exception 'cover_path must be inside the set folder';
  end if;
  -- Files are uploaded first; a set appears only once its pack file is really there.
  if not exists (select 1 from storage.objects o where o.bucket_id = 'sets' and o.name = new.file_path) then
    raise exception 'Upload the pack file before creating the set';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sets:' || auth.uid()::text, 0));
  if (select count(*) from public.sets where owner = auth.uid()) >= 40 then
    raise exception 'Library limit reached: 40 sets per person. Delete an old set first.';
  end if;
  return new;
end $$;
drop trigger if exists sets_before_insert on public.sets;
create trigger sets_before_insert before insert on public.sets for each row execute function public.sets_before_insert();

-- ---------- sync: compare-and-swap writes, server-ordered pagination ----------
create table if not exists public.sync_records (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  store text not null check (store in ('packs', 'sessions', 'sessionDetail', 'questionStats', 'snips', 'overrides', 'settings')),
  id text not null check (char_length(id) between 1 and 300),
  updated_at bigint not null,
  deleted boolean not null default false,
  data jsonb check (data is null or octet_length(data::text) <= 262144),
  synced_at timestamptz not null default clock_timestamp(),
  primary key (user_id, store, id)
);
-- Adding this column backfills old records. The migration never rewrites or removes their data.
alter table public.sync_records add column if not exists server_revision bigint generated always as identity;
create unique index if not exists sync_server_revision on public.sync_records (server_revision);
create index if not exists sync_revision_pull on public.sync_records (user_id, server_revision);
alter table public.sync_records enable row level security;
drop policy if exists sync_own on public.sync_records;
create policy sync_own on public.sync_records for select to authenticated
  using (user_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);

-- Only this RPC may write. The definer has a fixed empty search path and checks identity,
-- ownership, shape, quotas and conflicts itself. An account lock orders *commits* for its cursor;
-- a sequence alone would allow a late transaction to appear behind an already-pulled cursor.
create or replace function public.sync_push(records jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  x jsonb;
  old public.sync_records%rowtype;
  n integer := 0;
  additions integer;
  projected_bytes bigint;
  incoming bigint;
  base bigint;
  gone boolean;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    raise exception 'Sign in with a verified email account first';
  end if;
  if jsonb_typeof(records) is distinct from 'array' or jsonb_array_length(records) > 500
     or octet_length(records::text) > 4194304 then
    raise exception 'Push must contain at most 500 records and 4 MB';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sync:' || auth.uid()::text, 0));
  if exists (select 1 from jsonb_array_elements(records) e group by e->>'store', e->>'id' having count(*) > 1) then
    raise exception 'Duplicate records in one push';
  end if;
  select count(*) into additions from jsonb_array_elements(records) e
    where not exists (select 1 from public.sync_records r where r.user_id = auth.uid() and r.store = e->>'store' and r.id = e->>'id');
  if (select count(*) from public.sync_records where user_id = auth.uid()) + additions > 50000 then
    raise exception 'Sync creation limit reached; existing records can still be updated or deleted';
  end if;
  select coalesce(sum(octet_length(r.data::text)),0) into projected_bytes from public.sync_records r where r.user_id = auth.uid();
  select projected_bytes + coalesce(sum(
    (case when coalesce((e->>'deleted')::boolean,false) then 0 else coalesce(octet_length((e->'data')::text),0) end)
    - coalesce((select octet_length(r.data::text) from public.sync_records r where r.user_id = auth.uid() and r.store = e->>'store' and r.id = e->>'id'),0)
  ),0) into projected_bytes from jsonb_array_elements(records) e;
  if projected_bytes > 67108864 then raise exception 'Sync payload limit reached: 64 MB per account'; end if;
  for x in select value from jsonb_array_elements(records) loop
    if jsonb_typeof(x) is distinct from 'object'
       or (x->>'store') not in ('packs','sessions','sessionDetail','questionStats','snips','overrides','settings')
       or coalesce(char_length(x->>'id'),0) not between 1 and 300
       or jsonb_typeof(x->'updated_at') is distinct from 'number'
       or jsonb_typeof(x->'base_updated_at') is distinct from 'number'
       or exists (select 1 from jsonb_object_keys(x) k where k not in ('store','id','updated_at','base_updated_at','deleted','data')) then
      raise exception 'Invalid sync record';
    end if;
    incoming := (x->>'updated_at')::bigint;
    base := (x->>'base_updated_at')::bigint;
    gone := coalesce((x->>'deleted')::boolean, false);
    if incoming < 1 or incoming > 9007199254740991 or base < 0 then raise exception 'Invalid version'; end if;
    if not gone and (jsonb_typeof(x->'data') is distinct from 'object' or octet_length((x->'data')::text) > 262144) then
      raise exception 'Invalid sync payload';
    end if;
    if not gone and (x->>'store') <> 'settings' then
      if (x->>'store') in ('packs','sessions','sessionDetail') and x->'data'->>'id' is distinct from x->>'id' then
        raise exception 'Record id does not match payload';
      end if;
      if (x->>'store') in ('questionStats','snips','overrides') and x->'data'->>'key' is distinct from x->>'id' then
        raise exception 'Record key does not match payload';
      end if;
      if (x->>'store') <> 'packs' and coalesce(char_length(x->'data'->>'packId'),0) not between 1 and 300 then
        raise exception 'Missing pack id';
      end if;
      if (x->>'store') = 'sessions' and coalesce(x->'data'->>'status','') not in ('submitted','auto-submitted') then
        raise exception 'Only finished sessions sync';
      end if;
    end if;
    if not gone and (x->>'store') = 'sessionDetail' then
      if jsonb_typeof(x->'data'->'questionIds') is distinct from 'array'
         or jsonb_typeof(x->'data'->'answers') is distinct from 'array'
         or jsonb_array_length(x->'data'->'questionIds') not between 1 and 200
         or jsonb_array_length(x->'data'->'answers') <> jsonb_array_length(x->'data'->'questionIds') then
        raise exception 'Invalid bounded session details';
      end if;
      if x->'data' ? 'snapshots' then
        if jsonb_typeof(x->'data'->'snapshots') not in ('array','object') then raise exception 'Invalid question snapshots'; end if;
        if jsonb_typeof(x->'data'->'snapshots') = 'array' and jsonb_array_length(x->'data'->'snapshots') > 200 then raise exception 'Too many question snapshots'; end if;
        if jsonb_typeof(x->'data'->'snapshots') = 'object' and (select count(*) from jsonb_object_keys(x->'data'->'snapshots')) > 200 then raise exception 'Too many question snapshots'; end if;
      end if;
      if x->'data' ? 'regrades' and (jsonb_typeof(x->'data'->'regrades') is distinct from 'array' or jsonb_array_length(x->'data'->'regrades') > 100) then
        raise exception 'Invalid regrade history';
      end if;
    end if;
    if not gone and (x->>'store') = 'sessions' then
      if coalesce(x->'data'->>'type','') not in ('paper','random','drill','daily')
         or coalesce(x->'data'->>'mode','') not in ('exam','practice')
         or jsonb_typeof(x->'data'->'total') is distinct from 'number'
         or jsonb_typeof(x->'data'->'answered') is distinct from 'number'
         or jsonb_typeof(x->'data'->'correct') is distinct from 'number'
         or (x->'data'->>'total')::numeric not between 1 and 200
         or (x->'data'->>'answered')::numeric not between 0 and (x->'data'->>'total')::numeric
         or (x->'data'->>'correct')::numeric not between 0 and (x->'data'->>'answered')::numeric then
        raise exception 'Invalid session summary';
      end if;
    end if;
    if not gone and (x->>'store') not in ('packs','settings') and exists (
      select 1 from public.sync_records p where p.user_id = auth.uid() and p.store = 'packs'
      and p.id = x->'data'->>'packId' and p.deleted
    ) then raise exception 'The parent pack was deleted; restore it explicitly before editing dependent records'; end if;
    if (x->>'store') = 'settings' and x->>'id' <> 'settings' then raise exception 'Invalid settings id'; end if;
    select * into old from public.sync_records where user_id = auth.uid() and store = x->>'store' and id = x->>'id';
    -- A response lost after commit can safely be retried, even with its previous base token.
    if found and old.updated_at = incoming and old.deleted = gone and old.data is not distinct from
       (case when gone then null else x->'data' end) then
      n := n + 1;
      continue;
    end if;
    if (old.user_id is null and base <> 0) or (old.user_id is not null and old.updated_at <> base) then
      raise exception 'Sync conflict: pull the latest records before retrying' using errcode = '40001';
    end if;
    if old.user_id is not null and incoming = old.updated_at then raise exception 'Changed payload needs a new version'; end if;
    insert into public.sync_records as r (user_id, store, id, updated_at, deleted, data)
      values (auth.uid(), x->>'store', x->>'id', incoming, gone, case when gone then null else x->'data' end)
      on conflict (user_id, store, id) do update set updated_at = excluded.updated_at,
        deleted = excluded.deleted, data = excluded.data, synced_at = clock_timestamp(), server_revision = default;
    n := n + 1;
  end loop;
  -- A device may delete a pack before it has ever pulled all of another device's records.
  -- Tombstone those unknown dependents too; count and history remain retained on the server.
  for x in select value from jsonb_array_elements(records) e where e->>'store' = 'packs' and coalesce((e->>'deleted')::boolean,false) loop
    update public.sync_records r set deleted = true, data = null,
      updated_at = greatest(r.updated_at + 1, (x->>'updated_at')::bigint),
      synced_at = clock_timestamp(), server_revision = default
      where r.user_id = auth.uid() and r.store <> 'packs' and not r.deleted and r.data->>'packId' = x->>'id';
  end loop;
  for x in select value from jsonb_array_elements(records) e where e->>'store' in ('sessions','sessionDetail') and coalesce((e->>'deleted')::boolean,false) loop
    update public.sync_records r set deleted = true, data = null,
      updated_at = greatest(r.updated_at + 1, (x->>'updated_at')::bigint),
      synced_at = clock_timestamp(), server_revision = default
      where r.user_id = auth.uid() and r.id = x->>'id' and r.store in ('sessions','sessionDetail') and not r.deleted;
  end loop;
  return n;
end $$;

create or replace function public.sync_pull(after_revision text default null, page_limit integer default 500) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then raise exception 'Sign in first'; end if;
  if page_limit < 1 or page_limit > 500 then raise exception 'Invalid page size'; end if;
  if after_revision is not null and after_revision !~ '^[0-9]{1,19}$' then raise exception 'Invalid revision cursor'; end if;
  select jsonb_build_object('records', coalesce(jsonb_agg(jsonb_build_object(
    'store', p.store, 'id', p.id, 'updated_at', p.updated_at, 'deleted', p.deleted, 'data', p.data,
    'server_revision', p.server_revision::text) order by p.server_revision), '[]'::jsonb),
    'cursor', coalesce(max(p.server_revision)::text, after_revision)) into result
  from (select * from public.sync_records where user_id = auth.uid() and server_revision > coalesce(after_revision::bigint, 0)
        order by server_revision limit page_limit) p;
  return result;
end $$;

revoke all on public.sync_records from anon, authenticated;
grant select on public.sync_records to authenticated;
revoke all on function public.sync_push(jsonb), public.sync_pull(text, integer) from public, anon;
grant execute on function public.sync_push(jsonb), public.sync_pull(text, integer) to authenticated;

-- Private backups: at most three files / 400 MB per account, each at most 200 MB.
-- Deletes and replacement updates remain allowed at the creation quota.
drop policy if exists backups_own on storage.objects;
drop policy if exists backups_read on storage.objects;
create policy backups_read on storage.objects for select to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists backups_insert on storage.objects;
create policy backups_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);
drop policy if exists backups_update on storage.objects;
create policy backups_update on storage.objects for update to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists backups_delete on storage.objects;
create policy backups_delete on storage.objects for delete to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);

-- Enforce totals transactionally at the storage metadata boundary, including direct writes.
create or replace function public.storage_resource_limits() returns trigger
language plpgsql security definer set search_path = '' as $$
declare used_files bigint; used_bytes bigint; incoming_bytes bigint; owner_folder text;
begin
  if new.bucket_id not in ('sets','backups') then return new; end if;
  owner_folder := (storage.foldername(new.name))[1];
  perform pg_advisory_xact_lock(hashtextextended('storage:' || new.bucket_id || ':' || owner_folder, 0));
  if new.metadata->>'size' is not null and new.metadata->>'size' !~ '^[0-9]{1,12}$' then raise exception 'Invalid object size'; end if;
  incoming_bytes := coalesce((new.metadata->>'size')::bigint, 0);
  select count(*), coalesce(sum(coalesce((o.metadata->>'size')::bigint,0)),0) into used_files, used_bytes
    from storage.objects o where o.bucket_id = new.bucket_id and (storage.foldername(o.name))[1] = owner_folder
    and o.id <> new.id;
  if used_files + 1 > (case when new.bucket_id = 'backups' then 3 else 100 end)
     or used_bytes + incoming_bytes > 419430400
     or incoming_bytes > (case when new.bucket_id = 'backups' then 209715200 else 104857600 end) then
    raise exception 'Storage quota reached; remove an older file or use a smaller backup';
  end if;
  return new;
end $$;
drop trigger if exists storage_resource_limits on storage.objects;
create trigger storage_resource_limits before insert or update on storage.objects
  for each row execute function public.storage_resource_limits();

revoke all on function public.storage_resource_limits(), public.sets_before_insert(), public.sets_before_update(), public.stars_count(), public.reports_count() from public, anon, authenticated;
