import { beforeEach, describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import * as store from '../../src/lib/data/db';
import { backend } from '../../src/lib/backend';
import { buildPlan, loadPending, postSet, prepareFromFiles, prepareFromPack, type PostStep } from '../../src/lib/library/post';
import { downloadSet, updateAvailable } from '../../src/lib/library/download';
import { coverSvg, wrap } from '../../src/lib/library/cover';
import { doc, syntheticPaper } from '../fixtures/make';
import { importPack } from './helpers';

let n = 0;
const device = (name: string) => store.useDbName(`lib-${n}-${name}`);
beforeEach(async () => {
  n++;
  device('A');
  indexedDB.deleteDatabase('dmc-mock-server');
  await backend!.signOut();
});

const zipFile = (files: Record<string, Uint8Array>, name = 'set.zip') => new File([zipSync(files) as BlobPart], name, { type: 'application/zip' });
const pdf = (label: string) => strToU8(`%PDF-1.7\n% ${label}\n`.padEnd(400, ' '));
const paperWithPdf = (id: string, file: string) => ({ ...syntheticPaper(id, 4), pdf: { questionPaper: `pdfs/${file}` } });
const goodZip = () => zipFile({ 'pack.json': strToU8(JSON.stringify({ ...doc(paperWithPdf('p1', '9701_s23_qp_12.pdf'), syntheticPaper('p2', 4)), pack: { title: 'Chemistry 9701', subject: 'Chemistry' } })), 'pdfs/9701_s23_qp_12.pdf': pdf('chem 12') }, '9701_s23_qp_12.zip');
const meta = (title: string) => ({ title, description: '', subject: 'Chemistry', code: '9701' });
const quiet = () => {};
const cover = () => new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], { type: 'image/png' });

describe('preparing a set validates before anything uploads', () => {
  it('reads a paper-set zip, fills in the facts and the paper keys', async () => {
    const p = await prepareFromFiles([goodZip()]);
    expect(p.meta).toMatchObject({ title: 'Chemistry 9701', subject: 'Chemistry' });
    expect(p.facts).toEqual(['2 papers', '8 questions', 'all keyed', '1 PDF']);
    expect(p.keys.map((k) => [k.docId, k.key, k.status])).toEqual([['p1', '9701_s23_qp_12', 'found'], ['p2', null, 'missing']]);
    expect(p.base).toBe(0);
  });
  it('refuses invalid sets, hostile zips and personal backups', async () => {
    const bad = doc(syntheticPaper('p1', 4));
    (bad.papers[0] as { questions: { answer: string }[] }).questions[0]!.answer = 'Z';
    await expect(prepareFromFiles([zipFile({ 'pack.json': strToU8(JSON.stringify(bad)) })])).rejects.toThrow(/problem/);
    await expect(prepareFromFiles([zipFile({ 'pack.json': strToU8('{}'), '../x.png': new Uint8Array(1) })])).rejects.toThrow(/Unsafe path/);
    await expect(prepareFromFiles([zipFile({ 'dmc-backup.json': strToU8('{}'), 'data.json': strToU8('{}') })])).rejects.toThrow(/personal backup/);
  });
  it('a guessed key must be confirmed before a plan can be built', async () => {
    const p = await prepareFromFiles([zipFile({ 'pack.json': strToU8(JSON.stringify(doc(syntheticPaper('9701-s23-12', 4)))) })]);
    expect(p.keys[0]).toMatchObject({ status: 'confirm', suggestion: '9701_s23_qp_12' });
    await backend!.signInDev!('ana@stjbs.sch.id');
    await expect(buildPlan(p, meta('X'), {}, null)).rejects.toThrow(/Confirm the paper key/);
    const plan = await buildPlan(p, meta('X'), { '9701-s23-12': '9701_s23_qp_12' }, null);
    expect(plan.manifest.papers[0]!.key).toBe('9701_s23_qp_12');
  });
});

describe('posting', () => {
  it('a personal account cannot post or list', async () => {
    await backend!.signInDev!('ana.home@gmail.com');
    await expect(backend!.listSets({ search: '', limit: 10, offset: 0 })).rejects.toThrow(/school accounts/);
    await expect(prepareFromFiles([goodZip()]).then((p) => buildPlan(p, meta('X'), {}, null))).rejects.toThrow(/school accounts/);
  });
  it('steps through checking, uploading and publishing; cancel keeps finished files; resume completes once', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    const plan = await buildPlan(await prepareFromFiles([goodZip()]), meta('Chemistry 9701'), {}, cover());
    expect(plan.files.map((f) => f.label)).toEqual(['Typed questions', '9701_s23_qp_12.pdf', 'Cover']);
    const ac = new AbortController();
    const steps: PostStep[] = [];
    await expect(postSet(plan, (s) => { steps.push(s); if (s.step === 'uploading' && s.file === 2) ac.abort(); }, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(steps[0]).toEqual({ step: 'checking' });
    expect((await loadPending())?.setId).toBe(plan.setId);
    expect(await backend!.listSets({ search: '', limit: 10, offset: 0 })).toEqual([]);
    const resumed = (await loadPending())!;
    const after: PostStep[] = [];
    expect(await postSet(resumed, (s) => after.push(s), new AbortController().signal)).toEqual({ version: 1 });
    expect(after[after.length - 1]).toEqual({ step: 'publishing' });
    expect(after.filter((s) => s.step === 'uploading' && s.sent === 0).length).toBeLessThan(3);
    expect(await loadPending()).toBeNull();
    const sets = await backend!.listSets({ search: 'chem', limit: 10, offset: 0 });
    expect(sets.map((s) => [s.title, s.mine, s.version, s.paperCount])).toEqual([['Chemistry 9701', true, 1, 2]]);
  });
  it('files already in the Library are never uploaded again', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    await postSet(await buildPlan(await prepareFromFiles([goodZip()]), meta('First'), {}, null), quiet, new AbortController().signal);
    // A second set with the same PDF: only its own typed questions are new.
    const other = zipFile({ 'pack.json': strToU8(JSON.stringify(doc(paperWithPdf('x1', '9701_s23_qp_12.pdf')))), 'pdfs/9701_s23_qp_12.pdf': pdf('chem 12') }, 'other.zip');
    const plan = await buildPlan(await prepareFromFiles([other]), meta('Second'), {}, null);
    const uploaded: string[] = [];
    await postSet(plan, (s) => { if (s.step === 'uploading' && !uploaded.includes(s.label)) uploaded.push(s.label); }, new AbortController().signal);
    expect(uploaded).toEqual(['Typed questions']);
  });
  it('a second set with the same paper key links to the stored files instead of uploading its own copy', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    await postSet(await buildPlan(await prepareFromFiles([goodZip()]), meta('First'), {}, null), quiet, new AbortController().signal);
    const rescan = zipFile({ 'pack.json': strToU8(JSON.stringify(doc(paperWithPdf('y1', '9701_s23_qp_12.pdf')))), 'pdfs/9701_s23_qp_12.pdf': pdf('a different scan') }, 'rescan.zip');
    const plan = await buildPlan(await prepareFromFiles([rescan]), meta('Rescan'), {}, null);
    const [first] = (await backend!.lookupPapers(['9701_s23_qp_12']));
    expect(plan.manifest.papers[0]!.qp).toBe(first!.qp);
    expect(plan.files.map((f) => f.label)).toEqual(['Typed questions']);
  });
});

describe('one set across post, download, update and devices', () => {
  it('posting my pack uses its set ID; posting again is version 2 of the same set, never a second set', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    await postSet(await buildPlan(await prepareFromPack(pack), meta('Mine'), {}, null), quiet, new AbortController().signal);
    const linked = (await store.getPack(id))!;
    expect(linked.libraryVersion).toBe(1);
    const again = await prepareFromPack(linked);
    expect([again.setId, again.base]).toEqual([linked.setId, 1]);
    expect(await postSet(await buildPlan(again, meta('Mine'), {}, null), quiet, new AbortController().signal)).toEqual({ version: 2 });
    const sets = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    expect(sets.map((s) => [s.id, s.version])).toEqual([[linked.setId, 2]]);
    // Downloading my own set on this device updates my pack in place.
    const r = await downloadSet(sets[0]!);
    expect(r).toEqual({ packId: id, version: 2 });
    expect((await store.getPacks()).length).toBe(1);
  });
  it('another student downloads once, sees "Update available" after a new version, and updates the same copy', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    const plan = await buildPlan(await prepareFromFiles([goodZip()]), meta('Chemistry 9701'), {}, null);
    await postSet(plan, quiet, new AbortController().signal);
    await backend!.signInDev!('budi@stjbs.sch.id');
    device('B');
    let [set] = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    expect(updateAvailable(set!, await store.getPacks())).toBe('none');
    const first = await downloadSet(set!);
    expect('packId' in first && first.version).toBe(1);
    const pack = (await store.getPacks())[0]!;
    expect(pack).toMatchObject({ setId: set!.id, libraryVersion: 1, origin: { kind: 'library', setId: set!.id } });
    expect((await store.getPapers(pack.id)).map((p) => p.paperKey)).toContain('9701_s23_qp_12');
    expect(updateAvailable(set!, await store.getPacks())).toBe('current');
    // Ana posts version 2 with a third paper.
    await backend!.signInDev!('ana@stjbs.sch.id');
    device('A');
    const v2 = zipFile({ 'pack.json': strToU8(JSON.stringify({ ...doc(paperWithPdf('p1', '9701_s23_qp_12.pdf'), syntheticPaper('p2', 4), syntheticPaper('p3', 4)), pack: { title: 'Chemistry 9701', setId: plan.setId } })), 'pdfs/9701_s23_qp_12.pdf': pdf('chem 12') }, 'v2.zip');
    const prep = await prepareFromFiles([v2]);
    expect(prep.setId).toBe(plan.setId);
    await postSet(await buildPlan({ ...prep, base: 1 }, meta('Chemistry 9701'), {}, null), quiet, new AbortController().signal);
    await backend!.signInDev!('budi@stjbs.sch.id');
    device('B');
    [set] = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    expect(updateAvailable(set!, await store.getPacks())).toBe('update');
    expect(await downloadSet(set!)).toEqual({ packId: pack.id, version: 2 });
    expect((await store.getPacks()).length).toBe(1);
    expect((await store.getPack(pack.id))!.papers.length).toBe(3);
  });
  it('an edited question asks "keep mine or use the Library\'s"', async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    const plan = await buildPlan(await prepareFromFiles([goodZip()]), meta('Chemistry 9701'), {}, null);
    await postSet(plan, quiet, new AbortController().signal);
    const edited = doc(paperWithPdf('p1', '9701_s23_qp_12.pdf'), syntheticPaper('p2', 4));
    (edited.papers[1] as { questions: { stem: string }[] }).questions[0]!.stem = 'An edited stem';
    const v2 = zipFile({ 'pack.json': strToU8(JSON.stringify({ ...edited, pack: { title: 'Chemistry 9701', setId: plan.setId } })), 'pdfs/9701_s23_qp_12.pdf': pdf('chem 12') }, 'v2.zip');
    await backend!.signInDev!('budi@stjbs.sch.id');
    device('B');
    const [set] = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    const r1 = await downloadSet(set!);
    expect('packId' in r1).toBe(true);
    await backend!.signInDev!('ana@stjbs.sch.id');
    await postSet(await buildPlan({ ...(await prepareFromFiles([v2])), base: 1 }, meta('Chemistry 9701'), {}, null), quiet, new AbortController().signal);
    await backend!.signInDev!('budi@stjbs.sch.id');
    expect(await downloadSet(set!)).toEqual({ needsChoice: 1 });
    const packId = (r1 as { packId: string }).packId;
    const stem = async () => (await store.getPapers(packId)).find((p) => p.id === 'p2')!.questions[0]!.stem;
    const before = await stem();
    await downloadSet(set!, { prefer: 'mine' });
    expect(await stem()).toBe(before);
    await downloadSet(set!, { prefer: 'theirs' });
    expect(await stem()).toBe('An edited stem');
  });
  it("someone else's set cannot be posted as a new version", async () => {
    await backend!.signInDev!('ana@stjbs.sch.id');
    const plan = await buildPlan(await prepareFromFiles([goodZip()]), meta('Chemistry 9701'), {}, null);
    await postSet(plan, quiet, new AbortController().signal);
    await backend!.signInDev!('budi@stjbs.sch.id');
    device('B');
    const [set] = await backend!.listSets({ search: '', limit: 10, offset: 0 });
    const r = await downloadSet(set!);
    await expect(prepareFromPack((await store.getPack((r as { packId: string }).packId))!)).rejects.toThrow(/belongs to/);
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
