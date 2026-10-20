-- Supabase / Postgres schema for the optional leaderboard. Run once in the SQL editor.
-- Only the Netlify functions touch these objects, using the service key (which bypasses RLS).

create table if not exists public.scores (
  id           bigint generated always as identity primary key,
  pack_id      text        not null check (pack_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  pack_version text        not null check (length(pack_version) between 1 and 32),
  nickname     text        not null check (length(nickname) between 2 and 20),
  correct      integer     not null check (correct >= 0 and correct <= total),
  total        integer     not null check (total between 1 and 200),
  duration_ms  integer     not null check (duration_ms >= 2000 * total),
  client_id    text        not null,
  created_at   timestamptz not null default now()
);

create index if not exists scores_rank_idx on public.scores (pack_id, correct desc, duration_ms asc);

-- Row level security on, and no policies: the anon and authenticated roles can neither read nor write.
alter table public.scores enable row level security;

-- Best run per client per pack. security_invoker makes the view obey the table's RLS for any caller.
create or replace view public.best_scores with (security_invoker = true) as
  select distinct on (pack_id, client_id)
         pack_id, nickname, correct, total, duration_ms, created_at
    from public.scores
   order by pack_id, client_id, correct desc, duration_ms asc, created_at asc;

revoke all on public.scores, public.best_scores from anon, authenticated;
