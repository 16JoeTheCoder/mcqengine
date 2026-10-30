-- DMC: school Library, stars, reports, sync and private backups.
-- Where: Supabase dashboard > SQL Editor > New query. Paste this whole file and press Run.
-- Safe to run again: every statement is idempotent. See docs/SUPABASE_SETUP.md.
--
-- Access model (enforced here, on the server, never in the app):
--   * Any signed-in account (school or personal) may sync its own records and keep a private backup.
--   * The Library (sets, stars, reports, files) is for members only: an account whose email is
--     confirmed and whose email (from the signed auth token) ends in a domain listed in
--     library_domains, or is listed in library_allowlist. User-editable metadata is never read.

-- ---------- owner configuration: edit these two tables to change who may use the Library ----------
create table if not exists public.library_domains (
  domain text primary key check (domain = lower(domain) and domain ~ '^[a-z0-9.-]+\.[a-z]{2,}$')
);
insert into public.library_domains (domain) values ('stjbs.sch.id') on conflict do nothing;

create table if not exists public.library_allowlist (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  note text check (char_length(note) <= 200),
  added_at timestamptz not null default now()
);

create table if not exists public.library_admins (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  added_at timestamptz not null default now()
);

-- ---------- who is who ----------
-- Membership: a confirmed email, taken from the signed token and matched to auth.users, whose
-- domain is a school domain or which is on the allowlist. Anonymous sign-ins never qualify.
create or replace function public.is_library_member() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
      and lower(u.email) = lower(auth.jwt() ->> 'email')
      and (
        exists (select 1 from public.library_domains d where d.domain = lower(split_part(u.email, '@', 2)))
        or exists (select 1 from public.library_allowlist a where a.email = lower(u.email))
      )
  );
$$;

create or replace function public.is_library_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_library_member() and exists (
    select 1 from public.library_admins a where a.email = lower(auth.jwt() ->> 'email')
  );
$$;

-- What the app shows (locked or not, admin tools or not). The app never decides access itself.
create or replace function public.library_status() returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('member', public.is_library_member(), 'admin', public.is_library_admin());
$$;

-- ---------- sets ----------
create table if not exists public.sets (
  id uuid primary key default gen_random_uuid(),
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  owner_name text not null check (char_length(owner_name) between 1 and 80),
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 1000),
  subject text not null default '' check (char_length(subject) <= 80),
  code text not null default '' check (char_length(code) <= 20),
  paper_count int not null check (paper_count between 1 and 500),
  question_count int not null check (question_count between 0 and 20000),
  keyed boolean not null default false,
  file_path text not null check (char_length(file_path) <= 300),
  file_size bigint not null check (file_size between 1 and 104857600),
  cover_path text check (char_length(cover_path) <= 300),
  status text not null default 'approved' check (status in ('approved', 'hidden')),
  star_count int not null default 0,
  report_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists sets_rank on public.sets (star_count desc, created_at desc);
alter table public.sets enable row level security;

drop policy if exists sets_read on public.sets;
create policy sets_read on public.sets for select to authenticated
  using (public.is_library_member() and (status = 'approved' or owner = auth.uid() or public.is_library_admin()));

drop policy if exists sets_insert on public.sets;
create policy sets_insert on public.sets for insert to authenticated
  with check (public.is_library_member() and owner = auth.uid());

drop policy if exists sets_update on public.sets;
create policy sets_update on public.sets for update to authenticated
  using (public.is_library_member() and (owner = auth.uid() or public.is_library_admin()))
  with check (public.is_library_member() and (owner = auth.uid() or public.is_library_admin()));

drop policy if exists sets_delete on public.sets;
create policy sets_delete on public.sets for delete to authenticated
  using (public.is_library_member() and (owner = auth.uid() or public.is_library_admin()));

-- New sets start clean, inside the owner's folder, within a per-user quota.
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
  if (select count(*) from public.sets where owner = auth.uid()) >= 40 then
    raise exception 'Library limit reached: 40 sets per person. Delete an old set first.';
  end if;
  return new;
end $$;
drop trigger if exists sets_before_insert on public.sets;
create trigger sets_before_insert before insert on public.sets for each row execute function public.sets_before_insert();

-- Owners edit only name, description and cover; only admins change status; counters are the server's.
create or replace function public.sets_before_update() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Counter updates come from the stars and reports triggers (nested), never from a client.
  if pg_trigger_depth() > 1 then return new; end if;
  if new.owner <> old.owner or new.file_path <> old.file_path or new.file_size <> old.file_size
     or new.star_count <> old.star_count or new.report_count <> old.report_count or new.created_at <> old.created_at
     or new.paper_count <> old.paper_count or new.question_count <> old.question_count or new.keyed <> old.keyed
     or new.subject <> old.subject or new.code <> old.code or new.owner_name <> old.owner_name then
    raise exception 'Only the name, description and cover of a set can be changed';
  end if;
  if new.status <> old.status and not public.is_library_admin() then
    raise exception 'Only an admin can change a set''s status';
  end if;
  if new.cover_path is not null and new.cover_path not like (old.owner::text || '/' || old.id::text || '/cover.%') then
    raise exception 'cover_path must be inside the set folder';
  end if;
  return new;
end $$;
drop trigger if exists sets_before_update on public.sets;
create trigger sets_before_update before update on public.sets for each row execute function public.sets_before_update();

-- ---------- stars: one per person per set, toggled ----------
create table if not exists public.stars (
  set_id uuid not null references public.sets (id) on delete cascade,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (set_id, user_id)
);
alter table public.stars enable row level security;

drop policy if exists stars_read on public.stars;
create policy stars_read on public.stars for select to authenticated
  using (public.is_library_member() and user_id = auth.uid());
drop policy if exists stars_insert on public.stars;
create policy stars_insert on public.stars for insert to authenticated
  with check (public.is_library_member() and user_id = auth.uid() and exists (select 1 from public.sets s where s.id = set_id));
drop policy if exists stars_delete on public.stars;
create policy stars_delete on public.stars for delete to authenticated
  using (public.is_library_member() and user_id = auth.uid());

create or replace function public.stars_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    update public.sets set star_count = star_count + 1 where id = new.set_id;
  else
    update public.sets set star_count = greatest(0, star_count - 1) where id = old.set_id;
  end if;
  return null;
end $$;
drop trigger if exists stars_count on public.stars;
create trigger stars_count after insert or delete on public.stars for each row execute function public.stars_count();

-- ---------- reports: three distinct reports hide a set until an admin looks ----------
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  set_id uuid not null references public.sets (id) on delete cascade,
  reporter uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason text not null check (char_length(reason) between 1 and 500),
  created_at timestamptz not null default now(),
  unique (set_id, reporter)
);
alter table public.reports enable row level security;

drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (public.is_library_member() and reporter = auth.uid() and exists (select 1 from public.sets s where s.id = set_id));
drop policy if exists reports_read on public.reports;
create policy reports_read on public.reports for select to authenticated
  using (public.is_library_member() and (reporter = auth.uid() or public.is_library_admin()));
drop policy if exists reports_delete on public.reports;
create policy reports_delete on public.reports for delete to authenticated
  using (public.is_library_admin());

create or replace function public.reports_count() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.sets
     set report_count = report_count + 1,
         status = case when report_count + 1 >= 3 then 'hidden' else status end
   where id = new.set_id;
  return null;
end $$;
drop trigger if exists reports_count on public.reports;
create trigger reports_count after insert on public.reports for each row execute function public.reports_count();

-- ---------- sync: small per-user records, newest write wins ----------
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
create index if not exists sync_pull on public.sync_records (user_id, synced_at);
alter table public.sync_records enable row level security;

drop policy if exists sync_own on public.sync_records;
create policy sync_own on public.sync_records for all to authenticated
  using (user_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false)
  with check (user_id = auth.uid() and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false);

-- Push: insert, or replace only when the incoming record is newer. Runs as the caller, so RLS applies.
create or replace function public.sync_push(records jsonb) returns integer
language plpgsql security invoker set search_path = '' as $$
declare n integer;
begin
  if jsonb_array_length(records) > 500 then raise exception 'At most 500 records per push'; end if;
  if (select count(*) from public.sync_records where user_id = auth.uid()) > 50000 then
    raise exception 'Sync limit reached for this account';
  end if;
  insert into public.sync_records as r (user_id, store, id, updated_at, deleted, data, synced_at)
  select auth.uid(), x.store, x.id, x.updated_at, coalesce(x.deleted, false), x.data, clock_timestamp()
    from jsonb_to_recordset(records) as x(store text, id text, updated_at bigint, deleted boolean, data jsonb)
  on conflict (user_id, store, id) do update
    set updated_at = excluded.updated_at, deleted = excluded.deleted, data = excluded.data, synced_at = clock_timestamp()
    where excluded.updated_at > r.updated_at;
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- table privileges: nothing for anon; only what the policies need for signed-in users ----------
revoke all on public.library_domains, public.library_allowlist, public.library_admins, public.sets, public.stars, public.reports, public.sync_records from anon, authenticated;
grant select, insert, delete on public.sets to authenticated;
grant update (title, description, cover_path, status) on public.sets to authenticated;
grant select, insert, delete on public.stars to authenticated;
grant select, insert, delete on public.reports to authenticated;
grant select, insert, update, delete on public.sync_records to authenticated;
revoke all on function public.is_library_member(), public.is_library_admin(), public.library_status(), public.sync_push(jsonb) from public, anon;
grant execute on function public.is_library_member(), public.is_library_admin(), public.library_status(), public.sync_push(jsonb) to authenticated;

-- ---------- storage: private buckets, files served only through short-lived signed URLs ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sets', 'sets', false, 104857600, array['application/zip', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('backups', 'backups', false, 209715200, array['application/zip'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Set files live at <owner id>/<set id>/pack.zip and cover.<ext>. Reading needs Library membership
-- and a readable set (the same rule as the sets table), so a signed URL can only be made for those.
-- Owners may also read their own folder (to resume or clean up an unfinished post).
drop policy if exists sets_files_read on storage.objects;
create policy sets_files_read on storage.objects for select to authenticated
  using (
    bucket_id = 'sets' and public.is_library_member()
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or exists (
        select 1 from public.sets s
        where s.id::text = (storage.foldername(name))[2]
          and (s.status = 'approved' or s.owner = auth.uid() or public.is_library_admin())
      )
    )
  );

-- The caller's Library storage use (files, bytes). Security definer so the upload policy can
-- count without its own policy recursing into itself.
create or replace function public.library_storage_use() returns table (files bigint, bytes bigint)
language sql stable security definer set search_path = '' as $$
  select count(*), coalesce(sum((o.metadata ->> 'size')::bigint), 0)
    from storage.objects o
   where o.bucket_id = 'sets' and (storage.foldername(o.name))[1] = auth.uid()::text;
$$;
revoke all on function public.library_storage_use() from public, anon;
grant execute on function public.library_storage_use() to authenticated;

-- Uploads: members only, only into their own folder, within 400 MB and 100 files per person.
-- (Files go up before the set row exists; the row's trigger checks the file is there.)
drop policy if exists sets_files_insert on storage.objects;
create policy sets_files_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'sets' and public.is_library_member()
    and (storage.foldername(name))[1] = auth.uid()::text
    and array_length(storage.foldername(name), 1) = 2
    and (select u.files < 100 and u.bytes < 419430400 from public.library_storage_use() u)
  );

drop policy if exists sets_files_delete on storage.objects;
create policy sets_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'sets' and public.is_library_member() and ((storage.foldername(name))[1] = auth.uid()::text or public.is_library_admin()));

-- Private backups: any signed-in account, own folder only.
drop policy if exists backups_own on storage.objects;
create policy backups_own on storage.objects for all to authenticated
  using (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'backups' and (storage.foldername(name))[1] = auth.uid()::text);
