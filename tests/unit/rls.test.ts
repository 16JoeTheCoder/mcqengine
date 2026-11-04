// @vitest-environment node
// Runs the real supabase/schema.sql in Postgres (PGlite, in-process) with minimal stand-ins for the
// parts Supabase provides (auth.users, auth.uid(), auth.jwt(), storage.objects), then proves the
// access rules as each kind of account. These are the checks that matter: the app's own gating is
// only a convenience.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const SUPABASE_STUBS = `
create role anon nologin;
create role authenticated nologin;
create schema auth;
create table auth.users (id uuid primary key, email text, email_confirmed_at timestamptz, raw_user_meta_data jsonb not null default '{}');
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema public, auth, storage to anon, authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
`;

const U = {
  school: '00000000-0000-4000-8000-000000000001',
  personal: '00000000-0000-4000-8000-000000000002',
  unconfirmed: '00000000-0000-4000-8000-000000000003',
  spoof: '00000000-0000-4000-8000-000000000004',
  teacher: '00000000-0000-4000-8000-000000000005',
  admin: '00000000-0000-4000-8000-000000000006',
  school2: '00000000-0000-4000-8000-000000000007',
  sub: '00000000-0000-4000-8000-000000000008',
};
const EMAIL: Record<keyof typeof U, string> = {
  school: 'ana@stjbs.sch.id',
  personal: 'ana.home@gmail.com',
  unconfirmed: 'new@stjbs.sch.id',
  spoof: 'mallory@gmail.com',
  teacher: 'teacher@college.example',
  admin: 'owner@stjbs.sch.id',
  school2: 'budi@STJBS.sch.id',
  sub: 'eve@evil.stjbs.sch.id',
};

let db: PGlite;

async function as(who: keyof typeof U | null, extra: Record<string, unknown> = {}) {
  await db.exec('reset role');
  if (!who) return;
  const claims = JSON.stringify({ sub: U[who], email: EMAIL[who], role: 'authenticated', ...extra });
  await db.query(`select set_config('request.jwt.claims', $1, false)`, [claims]);
  await db.exec('set role authenticated');
}
const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
const fails = async (sql: string, params: unknown[] = []) => {
  try {
    await db.query(sql, params);
    return false;
  } catch {
    return true;
  }
};

const newSet = async (owner: keyof typeof U, id: string, title = 'Physics 9702') => {
  await q(`insert into storage.objects (bucket_id, name, metadata) values ('sets', $1, '{"size": 10}') on conflict do nothing`, [`${U[owner]}/${id}/pack.zip`]);
  return q(`insert into public.sets (id, owner_name, title, paper_count, question_count, file_path, file_size) values ($1, 'Ana', $2, 3, 120, $3, 1000) returning id`, [id, title, `${U[owner]}/${id}/pack.zip`]);
};
const SET_A = '10000000-0000-4000-8000-00000000000a';
const SET_B = '10000000-0000-4000-8000-00000000000b';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await db.exec(readFileSync(join(process.cwd(), 'supabase/schema.sql'), 'utf8'));
  for (const k of Object.keys(U) as (keyof typeof U)[])
    await db.query(`insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data) values ($1, $2, $3, $4)`, [U[k], EMAIL[k], k === 'unconfirmed' ? null : new Date(), k === 'spoof' ? { email: 'mallory@stjbs.sch.id', email_verified: true } : {}]);
  await db.query(`insert into public.library_allowlist (email) values ('teacher@college.example')`);
  await db.query(`insert into public.library_admins (email) values ('owner@stjbs.sch.id')`);
  await as('school');
  await newSet('school', SET_A);
  await as(null);
}, 60_000);

describe('Library access is server-side and needs a verified school email', () => {
  it('library_status reports membership from the server', async () => {
    await as('school');
    expect((await q<{ s: { member: boolean; admin: boolean } }>('select public.library_status() as s'))[0]!.s).toEqual({ member: true, admin: false });
    await as('personal');
    expect((await q<{ s: { member: boolean } }>('select public.library_status() as s'))[0]!.s.member).toBe(false);
  });

  it('a school account can list, read and get the file of a set', async () => {
    await as('school2');
    expect((await q('select id from public.sets')).map((r) => r.id)).toEqual([SET_A]);
    expect(await q(`select name from storage.objects where bucket_id = 'sets'`)).toHaveLength(1);
  });

  for (const who of ['personal', 'unconfirmed', 'spoof', 'sub'] as const)
    it(`a ${who} account cannot list, read or download a set, nor post, star or report`, async () => {
      await as(who);
      expect(await q('select id from public.sets')).toEqual([]);
      expect(await q(`select name from storage.objects where bucket_id = 'sets'`)).toEqual([]);
      expect(await fails(`insert into public.stars (set_id) values ($1)`, [SET_A])).toBe(true);
      expect(await fails(`insert into public.reports (set_id, reason) values ($1, 'x')`, [SET_A])).toBe(true);
      expect(await fails(`insert into public.sets (id, owner_name, title, paper_count, question_count, file_path, file_size) values ($1, 'X', 'X', 1, 1, $2, 1)`, [SET_B, `${U[who]}/${SET_B}/pack.zip`])).toBe(true);
    });

  it('a token that claims a school email for a personal account is refused', async () => {
    await as('personal', { email: 'ana@stjbs.sch.id' });
    expect(await q('select id from public.sets')).toEqual([]);
  });

  it('an anonymous sign-in is refused even with a school email', async () => {
    await as('school', { is_anonymous: true });
    expect(await q('select id from public.sets')).toEqual([]);
  });

  it('the anon role (signed out) sees nothing and can call nothing', async () => {
    await db.exec('reset role');
    await db.exec('set role anon');
    expect(await fails('select id from public.sets')).toBe(true);
    expect(await fails('select public.library_status()')).toBe(true);
    await db.exec('reset role');
  });

  it('the allowlist admits a teacher on another domain', async () => {
    await as('teacher');
    expect((await q('select id from public.sets')).map((r) => r.id)).toEqual([SET_A]);
  });
});

describe('sets, stars, reports, moderation', () => {
  it('posting is only into your own folder and starts clean', async () => {
    await as('school2');
    expect(await fails(`insert into public.sets (id, owner_name, title, paper_count, question_count, file_path, file_size) values ($1, 'B', 'B', 1, 1, $2, 1)`, [SET_B, `${U.school}/${SET_B}/pack.zip`])).toBe(true);
    const id = '10000000-0000-4000-8000-0000000000c1';
    const insert = () => q(`insert into public.sets (id, owner_name, title, paper_count, question_count, file_path, file_size, star_count, status) values ($1, 'B', 'Chem', 1, 1, $2, 1, 999, 'hidden')`, [id, `${U.school2}/${id}/pack.zip`]);
    expect(await fails(`insert into public.sets (id, owner_name, title, paper_count, question_count, file_path, file_size) values ($1, 'B', 'Chem', 1, 1, $2, 1)`, [id, `${U.school2}/${id}/pack.zip`])).toBe(true);
    expect(await fails(`insert into storage.objects (bucket_id, name, metadata) values ('sets', $1, '{"size": 5}')`, [`${U.school}/${id}/pack.zip`])).toBe(true);
    expect(await fails(`insert into storage.objects (bucket_id, name, metadata) values ('sets', $1, '{"size": 5}')`, [`${U.school2}/pack.zip`])).toBe(true);
    await q(`insert into storage.objects (bucket_id, name, metadata) values ('sets', $1, '{"size": 5}')`, [`${U.school2}/${id}/pack.zip`]);
    await insert();
    expect((await q('select star_count, status from public.sets where id = $1', [id]))[0]).toEqual({ star_count: 0, status: 'approved' });
  });

  it('owners edit name and description only; counters and status are not theirs', async () => {
    await as('school');
    await q(`update public.sets set title = 'Physics 9702 (all)' where id = $1`, [SET_A]);
    expect(await fails(`update public.sets set star_count = 50 where id = $1`, [SET_A])).toBe(true);
    expect(await fails(`update public.sets set status = 'hidden' where id = $1`, [SET_A])).toBe(true);
    await as('school2');
    expect(await q(`update public.sets set title = 'mine now' where id = $1 returning id`, [SET_A])).toEqual([]);
    expect(await q(`delete from public.sets where id = $1 returning id`, [SET_A])).toEqual([]);
  });

  it('one star per person, toggled, counted by the server', async () => {
    await as('school2');
    await q('insert into public.stars (set_id) values ($1)', [SET_A]);
    expect(await fails('insert into public.stars (set_id) values ($1)', [SET_A])).toBe(true);
    expect(await fails('insert into public.stars (set_id, user_id) values ($1, $2)', [SET_A, U.teacher])).toBe(true);
    await as('teacher');
    await q('insert into public.stars (set_id) values ($1)', [SET_A]);
    expect((await q('select star_count from public.sets where id = $1', [SET_A]))[0]!.star_count).toBe(2);
    await q('delete from public.stars where set_id = $1', [SET_A]);
    expect((await q('select star_count from public.sets where id = $1', [SET_A]))[0]!.star_count).toBe(1);
    expect(await q('select user_id from public.stars')).toEqual([]);
  });

  it('three reports hide a set from others; the owner and the admin still see it; the admin restores or removes it', async () => {
    const id = '10000000-0000-4000-8000-0000000000d1';
    await as('school');
    await newSet('school', id, 'To report');
    for (const who of ['school2', 'teacher', 'admin'] as const) {
      await as(who);
      await q(`insert into public.reports (set_id, reason) values ($1, 'not a past paper')`, [id]);
    }
    await as('school2');
    expect((await q('select id from public.sets where id = $1', [id]))).toEqual([]);
    expect(await q('select reason from public.reports')).toHaveLength(1);
    await as('school');
    expect((await q('select status from public.sets where id = $1', [id]))[0]!.status).toBe('hidden');
    await as('admin');
    expect(await q('select reason from public.reports where set_id = $1', [id])).toHaveLength(3);
    await q(`update public.sets set status = 'approved' where id = $1`, [id]);
    await as('school2');
    expect(await q('select id from public.sets where id = $1', [id])).toHaveLength(1);
    await as('admin');
    expect(await q('delete from public.sets where id = $1 returning id', [id])).toHaveLength(1);
  });

  it('only admins and owners delete files; others cannot', async () => {
    await as('school2');
    expect(await q(`delete from storage.objects where name like $1 returning name`, [`${U.school}/%`])).toEqual([]);
    await as('admin');
    expect((await q<{ s: { admin: boolean } }>('select public.library_status() as s'))[0]!.s.admin).toBe(true);
  });
});

describe('sync works for every signed-in account, and only for its owner', () => {
  const push = (records: unknown[]) => q<{ n: number }>('select public.sync_push($1::jsonb) as n', [JSON.stringify(records)]);
  it('uses compare-and-swap, rejects stale writes and isolates accounts', async () => {
    await as('personal');
    const record = (stamp: number, base: number, title: string) => ({ store: 'packs', id: 's1', updated_at: stamp, base_updated_at: base, data: { id: 's1', title } });
    expect((await push([record(10, 0, 'first')]))[0]!.n).toBe(1);
    expect(await fails('select public.sync_push($1::jsonb)', [JSON.stringify([record(5, 0, 'stale')])])).toBe(true);
    // A slow clock may still make a valid intentional edit; base version, not wall time, wins.
    expect((await push([record(5, 10, 'second')]))[0]!.n).toBe(1);
    expect((await push([record(5, 10, 'second')]))[0]!.n).toBe(1); // lost-response retry
    expect((await q<{ data: { title: string } }>('select data from public.sync_records'))[0]!.data.title).toBe('second');
    expect(await fails(`insert into public.sync_records (store,id,updated_at,data) values ('packs','bypass',1,'{}')`)).toBe(true);
    expect(await fails(`update public.sync_records set data = '{}'`)).toBe(true);
    expect(await fails('delete from public.sync_records')).toBe(true);
    await as('school');
    expect(await q('select id from public.sync_records')).toEqual([]);
    expect(await fails(`insert into public.sync_records (user_id, store, id, updated_at) values ($1, 'sessions', 'x', 1)`, [U.personal])).toBe(true);
  });
  it('paginates records with identical timestamps without loss and validates cursors', async () => {
    await as('personal');
    await push(Array.from({ length: 7 }, (_, i) => ({ store: 'packs', id: `page-${i}`, updated_at: 100, base_updated_at: 0, data: { id: `page-${i}` } })));
    await as(null);
    await q(`update public.sync_records set synced_at = '2026-11-02T00:00:00Z' where user_id = $1`, [U.personal]);
    await as('personal');
    const ids: string[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: { records: { id: string }[]; cursor: string } = (await q<{ p: { records: { id: string }[]; cursor: string } }>('select public.sync_pull($1,2) as p', [cursor]))[0]!.p;
      if (!page.records.length) break;
      ids.push(...page.records.map((r) => r.id));
      cursor = page.cursor;
    }
    expect(ids.filter((id) => id.startsWith('page-'))).toHaveLength(7);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await fails(`select public.sync_pull('2026-01-01T00:00:00Z',2)`)).toBe(true);
  });
  it('rolls back an entire batch on a conflicting record', async () => {
    await as('personal');
    const rows = [{ store: 'packs', id: 'rollback', updated_at: 1, base_updated_at: 0, data: { id: 'rollback' } },
      { store: 'packs', id: 's1', updated_at: 1000, base_updated_at: 0, data: { id: 's1' } }];
    expect(await fails('select public.sync_push($1::jsonb)', [JSON.stringify(rows)])).toBe(true);
    expect(await q(`select id from public.sync_records where id = 'rollback'`)).toEqual([]);
  });
  it('rejects unknown stores and oversized pushes', async () => {
    await as('personal');
    expect(await fails('select public.sync_push($1::jsonb)', [JSON.stringify([{ store: 'pdfs', id: 'x', updated_at: 1 }])])).toBe(true);
    expect(await fails('select public.sync_push($1::jsonb)', [JSON.stringify(Array.from({ length: 501 }, (_, i) => ({ store: 'sessions', id: `s${i}`, updated_at: 1 })))])).toBe(true);
  });
  it('private backups: own folder only', async () => {
    await as('personal');
    await q(`insert into storage.objects (bucket_id, name, metadata) values ('backups', $1, '{"size": 9}')`, [`${U.personal}/packs.zip`]);
    expect(await fails(`insert into storage.objects (bucket_id, name, metadata) values ('backups', $1, '{"size": 9}')`, [`${U.school}/packs.zip`])).toBe(true);
    await as('school');
    expect(await q(`select name from storage.objects where bucket_id = 'backups'`)).toEqual([]);
  });
  it('limits backup creation while permitting replacement and deletion', async () => {
    await as('personal');
    for (const name of ['two.zip','three.zip']) await q(`insert into storage.objects (bucket_id,name,metadata) values ('backups',$1,'{"size": 9}')`, [`${U.personal}/${name}`]);
    expect(await fails(`insert into storage.objects (bucket_id,name,metadata) values ('backups',$1,'{"size": 9}')`, [`${U.personal}/four.zip`])).toBe(true);
    await q(`update storage.objects set metadata = '{"size": 20}' where bucket_id = 'backups' and name = $1`, [`${U.personal}/two.zip`]);
    expect(await fails(`update storage.objects set metadata = '{"size": 300000000}' where bucket_id = 'backups' and name = $1`, [`${U.personal}/two.zip`])).toBe(true);
    await q(`delete from storage.objects where bucket_id = 'backups' and name = $1`, [`${U.personal}/three.zip`]);
    await q(`insert into storage.objects (bucket_id,name,metadata) values ('backups',$1,'{"size": 9}')`, [`${U.personal}/four.zip`]);
  });
  it('allows updates and tombstones at the sync creation quota', async () => {
    await as(null);
    await q(`insert into public.sync_records (user_id,store,id,updated_at,data)
      select $1::uuid, 'packs', 'quota-' || i, 1, jsonb_build_object('id','quota-' || i)
      from generate_series(1,50000) i`, [U.teacher]);
    await as('teacher');
    expect((await push([{ store:'packs', id:'quota-1', updated_at:2, base_updated_at:1, data:{id:'quota-1',title:'edit'} }]))[0]!.n).toBe(1);
    expect((await push([{ store:'packs', id:'quota-2', updated_at:2, base_updated_at:1, deleted:true, data:null }]))[0]!.n).toBe(1);
    expect(await fails('select public.sync_push($1::jsonb)', [JSON.stringify([{store:'packs',id:'over-quota',updated_at:1,base_updated_at:0,data:{id:'over-quota'}}])])).toBe(true);
    await as(null);
    await q('delete from public.sync_records where user_id=$1', [U.teacher]);
  });

  it('rejects unbounded session details and mismatched ids at the RPC boundary', async () => {
    await as('personal');
    for (const data of [
      {id:'bounded',packId:'p',questionIds:Array.from({length:201},(_,i)=>`q${i}`),answers:Array.from({length:201},(_,i)=>({qid:`q${i}`}))},
      {id:'other',packId:'p',questionIds:['q'],answers:[{qid:'q'}]},
      {id:'bounded',packId:'p',questionIds:['q'],answers:[{qid:'q'}],regrades:Array.from({length:101},()=>({}))},
    ]) expect(await fails('select public.sync_push($1::jsonb)', [JSON.stringify([{store:'sessionDetail',id:'bounded',updated_at:1,base_updated_at:0,data}])])).toBe(true);
  });
  it('deletes unknown dependents and blocks stale devices from recreating them', async () => {
    await as('personal');
    await push([{store:'packs',id:'cascade',updated_at:1,base_updated_at:0,data:{id:'cascade'}},
      {store:'overrides',id:'cascade::q',updated_at:1,base_updated_at:0,data:{key:'cascade::q',packId:'cascade'}}]);
    await push([{store:'packs',id:'cascade',updated_at:2,base_updated_at:1,deleted:true,data:null}]);
    expect((await q(`select deleted,data from public.sync_records where id='cascade::q'`))[0]).toEqual({deleted:true,data:null});
    expect(await fails('select public.sync_push($1::jsonb)',[JSON.stringify([{store:'snips',id:'cascade::new',updated_at:3,base_updated_at:0,data:{key:'cascade::new',packId:'cascade'}}])])).toBe(true);
    await push([{store:'packs',id:'cascade',updated_at:3,base_updated_at:2,data:{id:'cascade'}},
      {store:'overrides',id:'cascade::q',updated_at:3,base_updated_at:2,data:{key:'cascade::q',packId:'cascade'}}]);
    expect((await q(`select deleted from public.sync_records where id='cascade::q'`))[0]!.deleted).toBe(false);
  });
  it('applies the additive upgrade twice without deleting historical records', async () => {
    await as(null);
    const before = await q('select store,id,updated_at,server_revision from public.sync_records order by server_revision');
    const migration = readFileSync(join(process.cwd(),'supabase/migrations/20261102_sync_boundaries.sql'),'utf8');
    await db.exec(migration);
    await db.exec(migration);
    expect(await q('select store,id,updated_at,server_revision from public.sync_records order by server_revision')).toEqual(before);
  });

});
