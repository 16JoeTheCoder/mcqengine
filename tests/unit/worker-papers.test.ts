// @vitest-environment node
// Paper identity through the real Worker (workerd via Miniflare, real D1 and R2): match by file hash,
// text fingerprint and code, plus set subject edits.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bandsOf, fingerprintOf } from '../../shared/fingerprint';
import { pdfBytes, sha, startWorker, type Harness } from './worker-harness';

let h: Harness;
let seq = 0;
const uid = () => crypto.randomUUID();
const tag = (p: string) => `${p}${++seq}`;
const enc = new TextEncoder();
const KEY = '9702_s24_qp_12';

beforeAll(async () => { h = await startWorker(); }, 60_000);
afterAll(async () => { await h.dispose(); });

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (r: Response): Promise<Json> => (await r.json()) as Json;
const school = (p: string) => h.signIn(`${tag(p)}@stjbs.sch.id`);
const personal = (p: string) => h.signIn(`${tag(p)}@gmail.com`);

const textOf = (stride: number, mod: number, tail = '') => Array.from({ length: 300 }, (_, i) => `syn${(i * stride) % mod}w`).join(' ') + tail;
// Each test uses its own texts: the Worker's database is shared by the whole file.
const fpOf = (stride: number, mod: number, tail = '') => fingerprintOf(textOf(stride, mod, tail))!;
const FP_FILE = fpOf(2003, 9871);
const FP = fpOf(7919, 9973);
const FP_NEAR = fpOf(7919, 9973, ' one extra closing sentence appended here');
const FP_OTHER = fpOf(104729, 9967);
const FP_CODE_A = fpOf(3571, 9857);
const FP_CODE_B = fpOf(4513, 9851);

async function upload(as: string, bytes: Uint8Array, type: string): Promise<string> {
  const hash = sha(bytes);
  const r = await h.fetch(`/api/blobs/${hash}`, { method: 'PUT', as, body: bytes, headers: { 'content-type': type, 'content-length': String(bytes.byteLength) } });
  expect(r.status, `upload ${type}`).toBeLessThan(300);
  return hash;
}
/** Publishes a one-paper set; returns the ids and the question paper's hash. */
async function publish(as: string, o: { key?: string | null; fp?: string; label?: string; id?: string } = {}) {
  const id = o.id ?? uid();
  const label = o.label ?? id;
  const pack = await upload(as, enc.encode(`{"format":"dmc-pack/1","label":"${label}"}`), 'application/json');
  const qp = await upload(as, pdfBytes(label), 'application/pdf');
  const key = o.key === undefined ? null : o.key;
  const manifest = {
    format: 'dmc-set/1', pack, files: { 'pdfs/p.pdf': qp },
    papers: [{ id: 'p1', key, title: 'P1', questionCount: 40, keyed: 40, qp, ...(o.fp ? { fp: o.fp } : {}) }],
    meta: { title: `Set ${label}`, description: '', subject: 'Physics', code: '9702' },
  };
  const res = await h.fetch(`/api/sets/${id}/versions`, { method: 'POST', as, body: JSON.stringify({ base: 0, manifest }) });
  expect(res.status, await res.clone().text()).toBe(201);
  return { id, qp };
}
const match = (as: string | undefined, papers: unknown[]) => h.fetch('/api/papers/match', { method: 'POST', as, body: JSON.stringify({ papers }) });
const matches = async (as: string, papers: unknown[]) => {
  const r = await match(as, papers);
  expect(r.status, await r.clone().text()).toBe(200);
  return (await body(r)).matches as (Json | null)[];
};

describe('POST /api/papers/match access', () => {
  it('refuses anonymous callers with 401 and non-members with 403', async () => {
    expect((await match(undefined, [{ qp: sha('x') }])).status).toBe(401);
    const p = await personal('home');
    expect((await match(p.cookie, [{ qp: sha('x') }])).status).toBe(403);
  });
  it('lets a member ask and returns null for an unknown paper', async () => {
    const m = await school('ask');
    expect(await matches(m.cookie, [{ qp: sha('nothing here') }, {}])).toEqual([null, null]);
  });
});

describe('POST /api/papers/match results', () => {
  it('matches by exact hash as file, with the stored files and label', async () => {
    const m = await school('file');
    const { qp } = await publish(m.cookie, { key: KEY, fp: FP_FILE, label: 'file-match' });
    const [r] = await matches(m.cookie, [{ qp }]);
    expect(r).toMatchObject({ qp, ms: null, questionCount: 40, label: KEY, how: 'file', similarity: 1 });
  });
  it('matches a different hash by fingerprint as text, and not below the threshold', async () => {
    const m = await school('text');
    const { qp } = await publish(m.cookie, { fp: FP, label: 'text-match' });
    const other = sha('some other bytes');
    const [near, far] = await matches(m.cookie, [{ qp: other, fp: FP_NEAR }, { qp: other, fp: FP_OTHER }]);
    expect(near).toMatchObject({ qp, how: 'text' });
    expect(near!.similarity).toBeGreaterThanOrEqual(0.9);
    expect(far).toBeNull();
  });
  it('publishing stores the print and its 16 bands', async () => {
    const m = await school('bands');
    const fp = fingerprintOf(textOf(31, 9001, ' bands only'))!;
    const { qp } = await publish(m.cookie, { fp, key: null, label: 'bands' });
    expect((await h.sql('SELECT fingerprint, label FROM paper_prints WHERE qp_hash = ?1', qp))[0]).toEqual({ fingerprint: fp, label: null });
    expect((await h.sql<{ band: string }>('SELECT band FROM paper_bands WHERE qp_hash = ?1', qp)).map((r) => r.band).sort()).toEqual(bandsOf(fp).sort());
  });
  it('matches by code only when the stored print has no fingerprint', async () => {
    const m = await school('code');
    const keyA = '9702_w23_qp_12';
    const keyB = '9702_w23_qp_22';
    const a = await publish(m.cookie, { key: keyA, label: 'code-nofp' });
    const b = await publish(m.cookie, { key: keyB, fp: FP_CODE_B, label: 'code-withfp' });
    const other = sha('different bytes');
    const [noFp, withFp, askNoFp, askWrongFp] = await matches(m.cookie, [
      { qp: other, fp: FP_CODE_A, key: keyA },      // stored print has no fingerprint: the code links it
      { qp: other, fp: FP_CODE_A, key: keyB },      // stored print has a different fingerprint: refused
      { qp: other, key: keyB },                // ask carries no fingerprint: code links
      { qp: other, fp: FP_OTHER, key: keyB },   // another different fingerprint: refused
    ]);
    expect(noFp).toMatchObject({ qp: a.qp, how: 'code', label: keyA });
    expect(withFp).toBeNull();
    expect(askNoFp).toMatchObject({ qp: b.qp, how: 'code' });
    expect(askWrongFp).toBeNull();
  });
  it('rejects malformed asks with 400', async () => {
    const m = await school('bad');
    for (const ask of [{ fp: 'abc' }, { fp: 'g'.repeat(512) }, { fp: FP.slice(1) }, { qp: 'nothash' }, { key: 'not-a-key' }, { extra: 1 }]) {
      expect((await match(m.cookie, [ask])).status, JSON.stringify(ask).slice(0, 40)).toBe(400);
    }
    expect((await h.fetch('/api/papers/match', { method: 'POST', as: m.cookie, body: JSON.stringify({ papers: 'x' }) })).status).toBe(400);
  });
});

describe('PATCH /api/sets/<id> subject', () => {
  const patch = (as: string, id: string, b: unknown) => h.fetch(`/api/sets/${id}`, { method: 'PATCH', as, body: JSON.stringify(b) });
  const subjectOf = async (id: string) => (await h.sql<{ subject: string }>('SELECT subject FROM sets WHERE id = ?1', id))[0]!.subject;

  it('the owner changes the subject, other fields stay', async () => {
    const o = await school('own');
    const { id } = await publish(o.cookie, { label: 'subj-own' });
    expect((await patch(o.cookie, id, { subject: ' Chemistry ' })).status).toBe(200);
    expect(await subjectOf(id)).toBe('Chemistry');
    expect((await h.sql<{ title: string }>('SELECT title FROM sets WHERE id = ?1', id))[0]!.title).toBe('Set subj-own');
  });
  it('another member gets 403 and the subject is unchanged', async () => {
    const o = await school('own2');
    const x = await school('other');
    const { id } = await publish(o.cookie, { label: 'subj-other' });
    expect((await patch(x.cookie, id, { subject: 'Biology' })).status).toBe(403);
    expect(await subjectOf(id)).toBe('Physics');
  });
  it('a subject over 80 characters is 400; exactly 80 is fine', async () => {
    const o = await school('own3');
    const { id } = await publish(o.cookie, { label: 'subj-long' });
    expect((await patch(o.cookie, id, { subject: 'x'.repeat(81) })).status).toBe(400);
    expect(await subjectOf(id)).toBe('Physics');
    expect((await patch(o.cookie, id, { subject: 'x'.repeat(80) })).status).toBe(200);
    expect((await subjectOf(id)).length).toBe(80);
  });
});
