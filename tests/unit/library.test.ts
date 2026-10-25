import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as store from '../../src/lib/data/db';
import { backend } from '../../src/lib/backend';
import { postSet, prepareFromFiles, prepareFromPack, loadPending, type PostPlan } from '../../src/lib/library/post';
import { downloadSet, libraryPackId } from '../../src/lib/library/download';
import { coverSvg, wrap } from '../../src/lib/library/cover';
import { doc, syntheticPaper } from '../fixtures/make';
import { importPack } from './helpers';

let n = 0;
beforeEach(async () => {
  store.useDbName(`lib-${++n}`);
  await backend!.signOut();
});

const zipFile = (files: Record<string, Uint8Array>, name = 'set.zip') => new File([zipSync(files) as BlobPart], name, { type: 'application/zip' });
const goodZip = () => zipFile({ 'pack.json': strToU8(JSON.stringify({ ...doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)), pack: { title: 'Chemistry 9701', subject: 'Chemistry' } })) }, '9701_s23_qp_12.zip');

async function plan(file = goodZip()): Promise<PostPlan> {
  const prep = await prepareFromFiles([file]);
  const me = (await backend!.account())!;
  return { id: crypto.randomUUID(), ownerId: me.id, meta: prep.meta, ownerName: 'Ana', zip: prep.zip, cover: new Blob([new Uint8Array(10)], { type: 'image/png' }), done: [] };
}

describe('preparing a set validates before anything uploads', () => {
  it('reads a pack zip and fills in the facts', async () => {
    const p = await prepareFromFiles([goodZip()]);
    expect(p.meta).toMatchObject({ title: 'Chemistry 9701', subject: 'Chemistry', paperCount: 2, questionCount: 8, keyed: true });
    expect(p.facts).toEqual(['2 papers', '8 questions', 'all keyed']);
  });
  it('refuses invalid packs, hostile zips and personal backups', async () => {
    const bad = doc(syntheticPaper('p1', 4));
    (bad.papers[0] as { questions: { answer: string }[] }).questions[0]!.answer = 'Z';
    await expect(prepareFromFiles([zipFile({ 'pack.json': strToU8(JSON.stringify(bad)) })])).rejects.toThrow(/problem/);
    await expect(prepareFromFiles([zipFile({ 'pack.json': strToU8('{}'), '../x.png': new Uint8Array(1) })])).rejects.toThrow(/Unsafe path/);
    await expect(prepareFromFiles([zipFile({ 'dmc-backup.json': strToU8('{}'), 'data.json': strToU8('{}') })])).rejects.toThrow(/personal backup/);
  });
  it('a Library pack on this device cannot be re-posted', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = { ...(await store.getPack(id))!, origin: { kind: 'library' as const, setId: 'x' } };
    await expect(prepareFromPack(pack)).rejects.toThrow(/school Library/);
  });
});

describe('posting', () => {
  it('a personal account cannot post or list', async () => {
    await backend!.signInEmail('ana.home@gmail.com');
    await expect(backend!.listSets({ search: '', limit: 10, offset: 0 })).rejects.toThrow(/school accounts/);
    const p = await plan();
    await expect(postSet(p, () => {}, new AbortController().signal)).rejects.toThrow(/school accounts/);
  });
  it('cancel keeps finished steps; resume completes; the set appears once, with its file', async () => {
    await backend!.signInEmail('ana@stjbs.sch.id');
    const p = await plan();
    const ac = new AbortController();
    let seen = 0;
    await expect(postSet(p, (sent) => { seen = sent; if (sent > 0) ac.abort(); }, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toBeGreaterThan(0);
    expect((await loadPending())?.id).toBe(p.id);
    expect(await backend!.listSets({ search: '', limit: 10, offset: 0 })).toEqual([]);
    const progress: number[] = [];
    await postSet(p, (s, t) => progress.push(s / t), new AbortController().signal);
    expect(progress[progress.length - 1]).toBe(1);
    expect(await loadPending()).toBeNull();
    const sets = await backend!.listSets({ search: 'chem', limit: 10, offset: 0 });
    expect(sets.map((s) => [s.title, s.mine, s.stars])).toEqual([['Chemistry 9701', true, 0]]);
  });
  it('downloading imports through the same pipeline as a Library pack with a fixed id', async () => {
    await backend!.signInEmail('ana@stjbs.sch.id');
    await postSet(await plan(), () => {}, new AbortController().signal);
    await backend!.signInEmail('budi@stjbs.sch.id');
    const [set] = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    const id = await downloadSet(set!);
    expect(id).toBe(libraryPackId(set!.id));
    const pack = (await store.getPack(id))!;
    expect(pack.origin).toMatchObject({ kind: 'library', setId: set!.id });
    expect(pack.papers.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(await downloadSet(set!)).toBe(id);
    expect((await store.getPacks()).length).toBe(1);
  });
});

describe('default cover', () => {
  it('wraps and ellipsises the title, escapes text, one orange cap', () => {
    expect(wrap('Physics 9702 May/June 2023 all papers with keys and notes', 13, 3)).toEqual(['Physics 9702', 'May/June 2023', 'all papers…']);
    const svg = coverSvg('<A & B>', 'Physics 9702');
    expect(svg).toContain('&#60;A &#38; B&#62;');
    expect(svg.match(/#FF5B1F/g)).toHaveLength(1);
  });
});
