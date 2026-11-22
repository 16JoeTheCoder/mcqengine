// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { BACKUP_TABLES, primaryKey, restoreSql, sqlValue, jakartaDate, expired, type BackupTable } from '../../worker/backup-format';
// @ts-expect-error plain .mjs script without declarations
import { readBackup } from '../../scripts/restore-backup.mjs';
import { sha, startWorker, type Harness } from './worker-harness';

const DAY = 86_400_000;
type Row = Record<string, unknown>;
interface Listing { date: string; bytes: number; complete: boolean }

let h: Harness;
let admin: string;
const tmp: string[] = [];
const tmpDir = () => { const d = mkdtempSync(join(tmpdir(), 'dmc-backup-test-')); tmp.push(d); return d; };

interface Bucket {
  list(o: { prefix: string; cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get(k: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> } | null>;
}
async function r2(worker: Harness) { return (await worker.mf.getR2Bucket('FILES')) as unknown as Bucket; }
async function keys(worker: Harness, prefix: string): Promise<string[]> {
  const b = await r2(worker);
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await b.list({ prefix, cursor });
    out.push(...page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
async function listing(worker: Harness, cookie: string) {
  const r = await worker.fetch('/api/admin/backups', { as: cookie });
  expect(r.status).toBe(200);
  return (await r.json()) as { daily: Listing[]; weekly: Listing[] };
}
async function download(worker: Harness, prefix: string): Promise<string> {
  const dir = tmpDir();
  const b = await r2(worker);
  for (const k of await keys(worker, prefix)) {
    const o = await b.get(k);
    writeFileSync(join(dir, k.slice(prefix.length)), Buffer.from(await o!.arrayBuffer()));
  }
  return dir;
}
const pk = (t: BackupTable) => primaryKey(t).join(', ');
const dump = (worker: Harness, t: BackupTable) => worker.sql<Row>(`SELECT * FROM ${t} ORDER BY ${pk(t)}`);

const BIG = Array.from({ length: 1500 }, (_, i) => `row ${i} it's "quoted" é — ${'x'.repeat(60)}`).join('\n');

async function seed(worker: Harness) {
  const a = await worker.signIn('seed.one@stjbs.sch.id');
  const b = await worker.signIn('seed.two@gmail.com');
  await worker.sql("INSERT INTO library_admins (email, added_at, added_by) VALUES ('boss@stjbs.sch.id', 0, 'test')");
  await worker.sql("INSERT INTO library_allowlist (email, note, added_at, added_by) VALUES ('friend@gmail.com', 'it''s a note', 5, 'boss@stjbs.sch.id')");
  await worker.sql("INSERT INTO library_domains (domain) VALUES ('example.edu')");
  const setId = '11111111-1111-4111-8111-111111111111';
  await worker.sql('INSERT INTO sets (id, owner, owner_name, title, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 10, 11)', setId, a.id, 'Seed One', "Mechanics 'quoted'");
  await worker.sql('INSERT INTO set_versions (set_id, version, manifest, bytes, created_by, created_at) VALUES (?1, 1, ?2, 20, ?3, 12)', setId, '{"papers":[]}', a.id);
  const hash = 'a'.repeat(64);
  await worker.sql('INSERT INTO blobs (hash, size, type, first_uploader, created_at) VALUES (?1, 2000, ?2, ?3, 13)', hash, 'application/pdf', a.id);
  await worker.sql('INSERT INTO blob_refs (set_id, version, hash) VALUES (?1, 1, ?2)', setId, hash);
  await worker.sql('INSERT INTO stars (set_id, user_id, created_at) VALUES (?1, ?2, 14)', setId, b.id);
  await worker.sql("INSERT INTO sync_records (user_id, store, id, updated_at, deleted, data, bytes, server_revision, synced_at) VALUES (?1, 'packs', 'small', 1, 0, ?2, 10, 1, 2)", a.id, '{"a":"it\'s"}');
  await worker.sql("INSERT INTO sync_records (user_id, store, id, updated_at, deleted, data, bytes, server_revision, synced_at) VALUES (?1, 'sessions', 'big', 1, 0, ?2, ?3, 2, 2)", a.id, BIG, BIG.length);
  await worker.sql("INSERT INTO sync_records (user_id, store, id, updated_at, deleted, data, bytes, server_revision, synced_at) VALUES (?1, 'settings', 'gone', 1, 1, NULL, 0, 3, 2)", b.id);
  await worker.sql("UPDATE counters SET value = 3 WHERE name = 'sync'");
  await worker.sql("INSERT INTO usage_daily (day, user_id, downloads, download_bytes, uploads, upload_bytes) VALUES ('2026-11-01', ?1, 2, 4000, 0, 0)", a.id);
  return { a, b };
}

beforeAll(async () => {
  expect(BIG.length).toBeGreaterThan(60_000);
  h = await startWorker();
  await seed(h);
  admin = (await h.signIn('boss@stjbs.sch.id')).cookie;
}, 60_000);
afterAll(async () => {
  await h.dispose();
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

describe('manual backup', () => {
  it('is admin only', async () => {
    const member = (await h.signIn('plain@gmail.com')).cookie;
    expect((await h.fetch('/api/admin/backups', { method: 'POST' })).status).toBe(401);
    expect((await h.fetch('/api/admin/backups', { method: 'POST', as: member })).status).toBe(403);
    expect((await h.fetch('/api/admin/backups', { as: member })).status).toBe(403);
  });

  it('writes one gzipped JSON-lines file per table plus a manifest, never sessions', async () => {
    const r = await h.fetch('/api/admin/backups', { method: 'POST', as: admin });
    expect(r.status).toBe(201);
    const { manifest } = (await r.json()) as { manifest: { format: string; date: string; tables: Record<string, { rows: number; bytes: number }> } };
    expect(manifest.format).toBe('dmc-backup/1');
    expect(manifest.date).toBe(jakartaDate(Date.now()));
    const prefix = `backups/daily/${manifest.date}/`;
    const found = (await keys(h, prefix)).map((k) => k.slice(prefix.length)).sort();
    expect(found).toEqual([...BACKUP_TABLES.map((t) => `${t}.jsonl.gz`), 'manifest.json'].sort());
    expect(found.some((f) => f.startsWith('sessions'))).toBe(false);
    expect(Object.keys(manifest.tables).sort()).toEqual([...BACKUP_TABLES].sort());

    const bucket = await r2(h);
    const hashes = (await h.sql<{ token_hash: string }>('SELECT token_hash FROM sessions')).map((x) => x.token_hash);
    expect(hashes.length).toBeGreaterThan(0);
    let total = 0;
    for (const t of BACKUP_TABLES) {
      const text = gunzipSync(Buffer.from(await (await bucket.get(`${prefix}${t}.jsonl.gz`))!.arrayBuffer())).toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      expect(lines.length, t).toBe(manifest.tables[t]!.rows);
      for (const l of lines) JSON.parse(l);
      for (const hash of hashes) expect(text.includes(hash), t).toBe(false);
      total += lines.length;
    }
    expect(total).toBeGreaterThan(10);
    expect(manifest.tables.users!.rows).toBe(4);
    expect(manifest.tables.sync_records!.rows).toBe(3);
    const stored = JSON.parse(await (await bucket.get(`${prefix}manifest.json`))!.text());
    expect(stored).toEqual(manifest);
    expect(await keys(h, 'backups/weekly/')).toEqual(jakartaIsSunday(manifest.date) ? expect.any(Array) : []);
  });

  it('lists the backup as complete', async () => {
    const l = await listing(h, admin);
    expect(l.daily.length).toBeGreaterThan(0);
    expect(l.daily[0]).toMatchObject({ complete: true });
    expect(l.daily[0]!.bytes).toBeGreaterThan(0);
  });
});
function jakartaIsSunday(date: string) { return new Date(`${date}T00:00:00Z`).getUTCDay() === 0; }

describe('scheduled backups', () => {
  it('labels the date in Asia/Jakarta and keeps Sunday as a weekly copy', async () => {
    const w = await startWorker();
    try {
      // Saturday 17:00 UTC = Sunday 00:00 WIB.
      await w.scheduled(Date.UTC(2026, 10, 14, 17, 0));
      const daily = await keys(w, 'backups/daily/2026-11-15/');
      const weekly = await keys(w, 'backups/weekly/2026-11-15/');
      expect(daily).toContain('backups/daily/2026-11-15/manifest.json');
      expect(daily).toHaveLength(BACKUP_TABLES.length + 1);
      expect(weekly).toContain('backups/weekly/2026-11-15/manifest.json');
      expect(weekly).toHaveLength(BACKUP_TABLES.length + 1);
      expect(await keys(w, 'backups/daily/2026-11-14/')).toHaveLength(0);
      // Monday 00:00 WIB is not a weekly copy.
      await w.scheduled(Date.UTC(2026, 10, 15, 17, 0));
      expect(await keys(w, 'backups/daily/2026-11-16/')).toHaveLength(BACKUP_TABLES.length + 1);
      expect(await keys(w, 'backups/weekly/2026-11-16/')).toHaveLength(0);
    } finally { await w.dispose(); }
  }, 60_000);

  it('keeps 7 daily and 4 weekly backups', async () => {
    const w = await startWorker();
    try {
      // The cron's garbage collection runs at the (future) scheduled time and drops sessions, so sign in after each round.
      const list = async () => listing(w, (await w.signIn('josef.yang@stjbs.sch.id')).cookie);
      // 9 consecutive nights: WIB dates 2026-12-02 .. 2026-12-10.
      for (let i = 0; i < 9; i++) await w.scheduled(Date.UTC(2026, 11, 1, 17, 0) + i * DAY);
      let l = await list();
      expect(l.daily.map((d) => d.date)).toEqual(['2026-12-10', '2026-12-09', '2026-12-08', '2026-12-07', '2026-12-06', '2026-12-05', '2026-12-04']);
      expect(l.daily.every((d) => d.complete)).toBe(true);
      expect(l.weekly.map((d) => d.date)).toEqual(['2026-12-06']);
      expect(await keys(w, 'backups/daily/2026-12-03/')).toHaveLength(0);

      // Six Sundays, a week apart (WIB dates 2027-01-03, 01-10, ... 02-07).
      for (let i = 0; i < 6; i++) await w.scheduled(Date.UTC(2027, 0, 2, 17, 0) + i * 7 * DAY);
      l = await list();
      expect(l.weekly.map((d) => d.date)).toEqual(['2027-02-07', '2027-01-31', '2027-01-24', '2027-01-17']);
      expect(l.daily.length).toBeLessThanOrEqual(7);
      expect(await keys(w, 'backups/weekly/2026-12-06/')).toHaveLength(0);
    } finally { await w.dispose(); }
  }, 60_000);

  it('expired() keeps the newest', () => {
    expect(expired(['2026-01-02', '2026-01-01', '2026-01-03'], 2)).toEqual(['2026-01-01']);
    expect(expired(['2026-01-01'], 7)).toEqual([]);
  });
});

describe('restore', () => {
  let dir: string;
  beforeAll(async () => {
    await h.fetch('/api/admin/backups', { method: 'POST', as: admin });
    dir = await download(h, `backups/daily/${jakartaDate(Date.now())}/`);
  }, 60_000);

  it('round trips every table into an empty database, including long values', async () => {
    const { manifest, tables } = readBackup(dir);
    expect(manifest.format).toBe('dmc-backup/1');
    const stmts = restoreSql(tables);
    // The 100 KB-ish value goes in pieces below D1's statement limit.
    expect(stmts.filter((s) => s.startsWith('UPDATE sync_records SET data = data ||')).length).toBeGreaterThanOrEqual(2);
    expect(Math.max(...stmts.map((s) => s.length))).toBeLessThan(100_000);

    const fresh = await startWorker();
    try {
      const db = await fresh.mf.getD1Database('DB');
      for (const s of stmts) await db.prepare(s).run();
      for (const t of BACKUP_TABLES) {
        const live = await dump(h, t);
        // The admin's own "backup.run" audit row is written after the dump it describes.
        const expected = t === 'audit_log' ? live.filter((r) => r.action !== 'backup.run') : live;
        expect(t === 'audit_log' ? (await dump(fresh, t)).filter((r) => r.action !== 'backup.run') : await dump(fresh, t), t).toEqual(expected);
      }
      const big = await fresh.sql<{ data: string }>("SELECT data FROM sync_records WHERE id = 'big'");
      expect(big[0]!.data.length).toBe(BIG.length);
      expect(big[0]!.data).toBe(BIG);
      expect(sha(big[0]!.data)).toBe(sha(BIG));
      expect((await fresh.sql<{ value: number }>("SELECT value FROM counters WHERE name = 'sync'"))[0]!.value).toBe(3);
      expect(await fresh.sql('SELECT 1 FROM sessions')).toHaveLength(0);
    } finally { await fresh.dispose(); }
  }, 60_000);

  it('refuses a folder without manifest.json', () => {
    const d = tmpDir();
    cpSync(join(dir, 'users.jsonl.gz'), join(d, 'users.jsonl.gz'));
    expect(() => readBackup(d)).toThrow(/manifest\.json/);
  });

  it('refuses a row-count mismatch', () => {
    const d = tmpDir();
    cpSync(dir, d, { recursive: true });
    const m = JSON.parse(readFileSync(join(d, 'manifest.json'), 'utf8'));
    m.tables.users.rows += 1;
    writeFileSync(join(d, 'manifest.json'), JSON.stringify(m));
    expect(() => readBackup(d)).toThrow(/users: expected 5 rows, found 4/);
  });

  it('refuses a missing table file and a foreign format', () => {
    const d = tmpDir();
    cpSync(dir, d, { recursive: true });
    rmSync(join(d, 'stars.jsonl.gz'));
    expect(() => readBackup(d)).toThrow(/Missing stars\.jsonl\.gz/);
    const e = tmpDir();
    mkdirSync(e, { recursive: true });
    writeFileSync(join(e, 'manifest.json'), JSON.stringify({ format: 'other/1', tables: {} }));
    expect(() => readBackup(e)).toThrow(/Not a DMC backup/);
  });
});

describe('sql values', () => {
  it('escapes quotes and handles scalars', () => {
    expect(sqlValue("it's")).toBe("'it''s'");
    expect(sqlValue("''; DROP TABLE users; --")).toBe("'''''; DROP TABLE users; --'");
    expect(sqlValue(null)).toBe('NULL');
    expect(sqlValue(undefined)).toBe('NULL');
    expect(sqlValue(3.5)).toBe('3.5');
    expect(sqlValue(true)).toBe('1');
    expect(sqlValue(false)).toBe('0');
  });
  it('rejects non-finite numbers and unsupported values', () => {
    expect(() => sqlValue(NaN)).toThrow(/Non-finite/);
    expect(() => sqlValue(Infinity)).toThrow(/Non-finite/);
    expect(() => sqlValue(-Infinity)).toThrow(/Non-finite/);
    expect(() => sqlValue({})).toThrow(/Unsupported/);
  });
  it('rejects unsafe column names', () => {
    expect(() => restoreSql({ counters: [{ 'name; DROP TABLE x': 'a' }] })).toThrow(/Invalid column name/);
  });
});
