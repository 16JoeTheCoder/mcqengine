// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
// @ts-expect-error plain .mjs script without declarations
import { buildMigration, nameFromEmail, sizeSummary } from '../../scripts/migrate-supabase.mjs';
import { pdfBytes, pngBytes, sha, startWorker, type Harness } from './worker-harness';

type Row = Record<string, unknown>;
interface Migration { sql: string[]; blobs: Map<string, { bytes: Uint8Array; type: string; uploader: string }>; problems: string[]; counts: Record<string, number> }

const U = {
  alice: '11111111-1111-4111-8111-111111111111',
  bob: '22222222-2222-4222-8222-222222222222',
  carol: '33333333-3333-4333-8333-333333333333',
  dan: '44444444-4444-4444-8444-444444444444',
  eve: '55555555-5555-4555-8555-555555555555',
};
const S = {
  one: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  two: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  noZip: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  ghost: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  noPack: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
};
const PDF_NAME = 'pdfs/9702_s24_qp_12.pdf';
const qpPdf = pdfBytes('shared question paper');
const cover = pngBytes('cover-one');
const bigText = 'x'.repeat(70_500);

const packDoc = (title: string) => ({
  format: 'dmc-pack/1',
  pack: { title },
  papers: [{
    id: 'p1', title: 'May/June 2024 Paper 12', questionCount: 2, pdf: { questionPaper: PDF_NAME },
    questions: [
      { n: 1, stem: 'a', options: ['1', '2', '3', '4'], answer: 'A' },
      { n: 2, stem: 'b', options: ['1', '2', '3', '4'], answer: 'B' },
    ],
  }],
});
const packZip = (title: string, extra: Record<string, Uint8Array> = {}) =>
  zipSync({ 'pack.json': strToU8(JSON.stringify(packDoc(title))), [PDF_NAME]: qpPdf, ...extra });

const zips: Record<string, Uint8Array> = {
  'one/pack.zip': packZip('Set one'),
  'two/pack.zip': packZip('Set two'),
  'noPack/pack.zip': zipSync({ 'readme.txt': strToU8('nothing here') }),
};
const files = async (path: string) => (path.endsWith('.png') ? cover : zips[path] ?? null);

const t = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString();
const src = () => ({
  domains: [{ domain: 'STJBS.sch.id' }],
  allowlist: [{ email: 'Carol@Gmail.com', note: 'external teacher', added_at: t(1) }],
  admins: [{ email: 'dan@gmail.com', added_at: t(2) }],
  users: [
    { id: U.alice, email: 'alice.tan@stjbs.sch.id', email_confirmed_at: t(1), created_at: t(1), user_metadata: { full_name: 'Alice Tan' } },
    { id: U.bob, email: 'bob_lee@stjbs.sch.id', email_confirmed_at: t(2), created_at: t(2), user_metadata: {} },
    { id: U.carol, email: 'carol@gmail.com', email_confirmed_at: t(3), created_at: t(3) },
    { id: U.dan, email: 'dan@gmail.com', email_confirmed_at: t(4), created_at: t(4) },
    { id: U.eve, email: 'eve@gmail.com', email_confirmed_at: null, created_at: t(5) },
  ],
  sets: [
    { id: S.one, owner: U.alice, owner_name: 'Alice Tan', title: 'Set one', description: 'd', subject: 'Physics', code: '9702', file_path: 'one/pack.zip', cover_path: 'one/cover.png', status: 'approved', created_at: t(10) },
    { id: S.two, owner: U.bob, owner_name: 'Bob Lee', title: 'Set two', description: null, subject: 'Physics', code: '9702', file_path: 'two/pack.zip', cover_path: null, status: 'approved', created_at: t(11) },
    { id: S.noZip, owner: U.alice, owner_name: 'Alice Tan', title: 'Missing zip', file_path: 'nowhere/pack.zip', status: 'approved', created_at: t(12) },
    { id: S.ghost, owner: '99999999-9999-4999-8999-999999999999', owner_name: 'Ghost', title: 'Ghost owner', file_path: 'one/pack.zip', status: 'approved', created_at: t(13) },
    { id: S.noPack, owner: U.alice, owner_name: 'Alice Tan', title: 'No pack json', file_path: 'noPack/pack.zip', status: 'approved', created_at: t(14) },
  ],
  stars: [
    { set_id: S.one, user_id: U.bob, created_at: t(20) },
    { set_id: S.one, user_id: U.carol, created_at: t(21) },
    { set_id: S.one, user_id: '99999999-9999-4999-8999-999999999999', created_at: t(22) }, // unknown user: dropped
    { set_id: S.noZip, user_id: U.bob, created_at: t(23) }, // skipped set: dropped
  ],
  reports: [{ id: '66666666-6666-4666-8666-666666666666', set_id: S.one, reporter: U.bob, reason: 'Wrong key on Q3', created_at: t(30) }],
  sync: [
    // Deliberately out of server order; migration must renumber in the old order.
    { user_id: U.bob, store: 'settings', id: 'settings', updated_at: 5000, deleted: false, data: { theme: 'dark' }, server_revision: 30, synced_at: t(40) },
    { user_id: U.alice, store: 'settings', id: 'settings', updated_at: 1000, deleted: false, data: { theme: 'light' }, server_revision: 10, synced_at: t(40) },
    { user_id: U.alice, store: 'packs', id: 'pk1', updated_at: 2000, deleted: false, data: { id: 'pk1', title: 'Mine', note: bigText }, server_revision: 20, synced_at: t(41) },
    { user_id: U.alice, store: 'overrides', id: 'ov1', updated_at: 3000, deleted: true, data: null, server_revision: 25, synced_at: t(42) },
    { user_id: '99999999-9999-4999-8999-999999999999', store: 'settings', id: 'settings', updated_at: 1, deleted: false, data: {}, server_revision: 1, synced_at: t(40) },
  ],
});

describe('nameFromEmail and sizeSummary', () => {
  it('derives display names the way the Worker does', () => {
    expect(nameFromEmail('josef.yang@stjbs.sch.id')).toBe('Josef Yang');
    expect(nameFromEmail('ana_maria-lopez@x.org')).toBe('Ana Maria Lopez');
    expect(nameFromEmail('12345@x.org')).toBe('12345');
    expect(nameFromEmail('@x.org')).toBe('DMC user');
  });
  it('summarises one line per type, with counts', () => {
    const blobs = new Map([
      ['a', { bytes: new Uint8Array(1048576), type: 'application/pdf', uploader: 'u' }],
      ['b', { bytes: new Uint8Array(1048576 * 3), type: 'application/pdf', uploader: 'u' }],
      ['c', { bytes: new Uint8Array(10), type: 'image/png', uploader: 'u' }],
    ]);
    const lines = sizeSummary(blobs);
    expect(lines).toHaveLength(2);
    expect(lines.find((l: string) => l.startsWith('application/pdf'))).toContain('2 files, total 4.00 MB, largest 3.00 MB');
    expect(lines.find((l: string) => l.startsWith('image/png'))).toContain('1 files');
  });
});

describe('buildMigration (pure)', () => {
  it('reports problems without breaking the rest', async () => {
    const m: Migration = await buildMigration(src(), files, 1_800_000_000_000);
    expect(m.counts).toMatchObject({ users: 5, sets: 2, stars: 2, reports: 1, sync: 4 });
    expect(m.problems).toHaveLength(3);
    expect(m.problems.some((p) => p.includes(S.noZip) && /pack\.zip missing/.test(p))).toBe(true);
    expect(m.problems.some((p) => p.includes(S.ghost) && /owner account missing/.test(p))).toBe(true);
    expect(m.problems.some((p) => p.includes(S.noPack) && /no pack\.json/.test(p))).toBe(true);
  });
  it('stores identical PDFs once', async () => {
    const m: Migration = await buildMigration(src(), files);
    const pdfs = [...m.blobs.values()].filter((b) => b.type === 'application/pdf');
    expect(pdfs).toHaveLength(1);
    // two pack.json blobs, one PDF, one cover
    expect(m.blobs.size).toBe(4);
    expect(m.counts.blobs).toBe(4);
  });
  it('splits text over the statement limit into UPDATE pieces', async () => {
    const m: Migration = await buildMigration(src(), files);
    const chunks = m.sql.filter((s) => s.startsWith('UPDATE sync_records SET data = data ||'));
    expect(chunks).toHaveLength(2);
  });
});

describe('migration applied to the real Worker', () => {
  let h: Harness;
  let m: Migration;
  const tokens: Record<string, string> = {};
  const as = (name: keyof typeof U) => tokens[name]!;
  const getJson = async (path: string, who: keyof typeof U) => {
    const r = await h.fetch(path, { as: as(who) });
    return { status: r.status, body: (await r.json()) as Row };
  };

  beforeAll(async () => {
    h = await startWorker();
    m = await buildMigration(src(), files, 1_800_000_000_000);
    const db = await h.mf.getD1Database('DB');
    await db.batch(m.sql.map((s) => db.prepare(s)));
    const bucket = (await h.mf.getR2Bucket('FILES')) as unknown as { put(k: string, v: Uint8Array): Promise<unknown> };
    for (const [hash, b] of m.blobs) await bucket.put(`blobs/${hash}`, b.bytes);
    // A first Google sign-in sets hd; simulate it for school emails.
    await db.prepare(`UPDATE users SET hd = 'stjbs.sch.id' WHERE email LIKE '%@stjbs.sch.id'`).run();
    const now = Date.now();
    for (const [name, id] of Object.entries(U)) {
      const token = randomBytes(32).toString('base64url');
      tokens[name] = token;
      await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, absolute_expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?3)')
        .bind(createHash('sha256').update(token).digest('hex'), id, now, now + 86_400_000, now + 2 * 86_400_000).run();
    }
  }, 120_000);
  afterAll(async () => { await h?.dispose(); });

  it('keeps the original set id and lists it with version, stars and reports', async () => {
    const { status, body } = await getJson('/api/sets', 'alice');
    expect(status).toBe(200);
    const sets = body.sets as Row[];
    expect(sets.map((s) => s.id).sort()).toEqual([S.one, S.two].sort());
    const one = sets.find((s) => s.id === S.one)!;
    expect(one).toMatchObject({ version: 1, stars: 2, reports: 1, title: 'Set one', paperCount: 1, questionCount: 2, keyed: true });
    expect(one.coverHash).toBe(sha(cover));
    expect(sets.find((s) => s.id === S.two)).toMatchObject({ version: 1, stars: 0, reports: 0 });
  });

  it('serves a manifest whose pack, PDF and cover download intact', async () => {
    const { body } = await getJson(`/api/sets/${S.one}`, 'bob');
    const manifest = body.manifest as { papers: Row[]; pack: string; files: Record<string, string>; cover: string; setId: string; version: number };
    expect(manifest).toMatchObject({ setId: S.one, version: 1 });
    expect(manifest.papers[0]!.key).toBe('9702_s24_qp_12');
    expect(manifest.papers[0]!.qp).toBe(sha(qpPdf));

    const packRes = await h.fetch(`/api/blob/${manifest.pack}`, { as: as('bob') });
    expect(packRes.status).toBe(200);
    const doc = JSON.parse(await packRes.text());
    expect(doc.pack.setId).toBe(S.one);
    expect(doc.pack.version).toBe(1);
    expect(doc.papers[0].questions).toHaveLength(2);

    const pdfRes = await h.fetch(`/api/blob/${manifest.files[PDF_NAME]}`, { as: as('bob') });
    expect(pdfRes.status).toBe(200);
    expect(new Uint8Array(await pdfRes.arrayBuffer())).toEqual(qpPdf);

    const coverRes = await h.fetch(`/api/blob/${manifest.cover}`, { as: as('bob') });
    expect(new Uint8Array(await coverRes.arrayBuffer())).toEqual(cover);
  });

  it('registers the paper key, and stores the shared PDF once', async () => {
    const r = await h.fetch('/api/papers/lookup', { method: 'POST', as: as('alice'), body: JSON.stringify({ keys: ['9702_s24_qp_12'] }) });
    const body = (await r.json()) as { papers: Row[] };
    expect(body.papers).toHaveLength(1);
    expect(body.papers[0]).toMatchObject({ key: '9702_s24_qp_12', qp: sha(qpPdf), questionCount: 2 });
    expect((await h.sql<{ n: number }>(`SELECT count(*) AS n FROM blobs WHERE type = 'application/pdf'`))[0]!.n).toBe(1);
    expect((await h.sql<{ n: number }>('SELECT count(*) AS n FROM blobs'))[0]!.n).toBe(m.blobs.size);
    expect((await h.sql<{ n: number }>('SELECT count(*) AS n FROM sets'))[0]!.n).toBe(2);
  });

  it('gives allowlisted and admin accounts their access, and nobody else', async () => {
    const carol = await getJson('/api/me', 'carol');
    expect(carol.body.status).toMatchObject({ member: true, admin: false });
    const dan = await getJson('/api/me', 'dan');
    expect(dan.body.status).toMatchObject({ member: true, admin: true });
    const alice = await getJson('/api/me', 'alice');
    expect(alice.body.status).toMatchObject({ member: true, admin: false });
    expect((await getJson('/api/sets', 'eve')).status).toBe(403);
  });

  it('pulls only the caller\'s records, in increasing revision order', async () => {
    const alice = await getJson('/api/sync/pull', 'alice');
    const recs = alice.body.records as Row[];
    expect(recs.map((r) => r.id)).toEqual(['settings', 'pk1', 'ov1']);
    const revs = recs.map((r) => Number(r.server_revision));
    expect(revs).toEqual([...revs].sort((a, b) => a - b));
    expect(new Set(revs).size).toBe(3);
    expect(recs[0]!.data).toEqual({ theme: 'light' });
    expect(recs[2]).toMatchObject({ deleted: true, data: null });
    const bob = (await getJson('/api/sync/pull', 'bob')).body.records as Row[];
    expect(bob).toHaveLength(1);
    expect(bob[0]!.data).toEqual({ theme: 'dark' });
    expect((await getJson('/api/sync/pull', 'eve')).body.records).toEqual([]);
  });

  it('round-trips a record longer than one statement chunk', async () => {
    const recs = (await getJson('/api/sync/pull', 'alice')).body.records as Row[];
    const big = recs.find((r) => r.id === 'pk1')!;
    expect((big.data as { note: string }).note).toBe(bigText);
    const [row] = await h.sql<{ bytes: number; len: number }>(`SELECT bytes, length(data) AS len FROM sync_records WHERE id = 'pk1'`);
    expect(row!.len).toBeGreaterThan(70_000);
    expect(row!.bytes).toBe(Buffer.byteLength(JSON.stringify({ id: 'pk1', title: 'Mine', note: bigText })));
  });

  it('sets the sync counter to the number of migrated rows and continues from it', async () => {
    const [c] = await h.sql<{ value: number }>(`SELECT value FROM counters WHERE name = 'sync'`);
    expect(c!.value).toBe(m.counts.sync);
    expect(c!.value).toBe(4);

    // CAS continuity: a push based on the migrated updated_at succeeds and gets a new revision.
    const push = (base: number, at: number) => h.fetch('/api/sync/push', {
      method: 'POST', as: as('alice'),
      body: JSON.stringify({ records: [{ store: 'settings', id: 'settings', updated_at: at, base_updated_at: base, deleted: false, data: { theme: 'sepia' } }] }),
    });
    const stale = await push(999, 1500);
    expect(stale.status).toBe(409);
    const ok = await push(1000, 1500);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ accepted: 1 });
    const after = (await getJson('/api/sync/pull?after=3', 'alice')).body.records as Row[];
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'settings', updated_at: 1500, data: { theme: 'sepia' } });
    expect(Number(after[0]!.server_revision)).toBe(5);
  });
});
