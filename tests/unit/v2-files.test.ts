import { beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import * as store from '../../src/lib/data/db';
import { readZip, unzipGuarded, unsafePath, ZipError } from '../../src/lib/data/files';
import { bareImport, defaultMinutes } from '../../src/lib/data/bare';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { applyRestore, createBackup, exportPackZip, planRestore, ShareError } from '../../src/lib/data/backup';
import { createSession, loadPackContent, poolOf } from '../../src/lib/engine/session';
import { pairFiles, parseFileName } from '../../src/lib/format/filename';
import { crossCheck } from '../../src/lib/format/crosscheck';
import { validateDoc } from '../../src/lib/format/validate';
import { checkSource } from '../../src/lib/format/check';
import { markSchemePdf, questionPaperPdf } from '../fixtures/pdf';
import { doc, syntheticPaper } from '../fixtures/make';
import { importPack } from './helpers';

let n = 0;
beforeEach(() => store.useDbName(`v2f-${++n}`));

describe('zip guards', () => {
  it('refuses path traversal, absolute paths and drive letters', async () => {
    expect(unsafePath('../evil.json')).toBe(true);
    expect(unsafePath('a/../../b')).toBe(true);
    expect(unsafePath('/etc/passwd')).toBe(true);
    expect(unsafePath('C:/x')).toBe(true);
    expect(unsafePath('images/q1.png')).toBe(false);
    const z = zipSync({ 'pack.json': strToU8('{}'), '../../evil.png': new Uint8Array([1]) });
    await expect(readZip(new Blob([z as BlobPart]), 'x.zip')).rejects.toThrow(/Unsafe path/);
  });
  it('stops a decompression bomb while inflating, whatever the header claims', async () => {
    const big = new Uint8Array(5_000_000); // compresses to a few kB
    const z = zipSync({ 'pack.json': strToU8('{}'), 'images/a.png': big, 'images/b.png': big }, { level: 9 });
    expect(z.byteLength).toBeLessThan(100_000);
    await expect(unzipGuarded(new Blob([z as BlobPart]), { entries: 10, entryBytes: 6_000_000, totalBytes: 8_000_000 })).rejects.toThrow(/size limit/);
    await expect(unzipGuarded(new Blob([z as BlobPart]), { entries: 10, entryBytes: 4_000_000, totalBytes: 80_000_000 })).rejects.toThrow(/size limit/);
  });
  it('caps the number of entries', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 30; i++) files[`f${i}.txt`] = strToU8('x');
    await expect(unzipGuarded(new Blob([zipSync(files) as BlobPart]), { entries: 20, entryBytes: 1e6, totalBytes: 1e7 })).rejects.toBeInstanceOf(ZipError);
  });
  it('a damaged zip is an error, not a crash', async () => {
    await expect(readZip(new Blob([new Uint8Array([80, 75, 3, 4, 1, 2, 3])]), 'x.zip')).rejects.toBeTruthy();
  });
});

describe('file names', () => {
  it('parses Cambridge names into title, group, id and subject', () => {
    expect(parseFileName('9702_s23_qp_12.pdf')).toMatchObject({ code: '9702', subject: 'Physics', series: 'May/June', year: 2023, kind: 'qp', paper: '12', id: '9702-s23-12', title: 'May/June 2023 Paper 12', group: ['2023', 'May/June'] });
    expect(parseFileName('0625_w22_ms_22.pdf')).toMatchObject({ series: 'Oct/Nov', kind: 'ms', id: '0625-w22-22' });
    expect(parseFileName('folder/9701_m24_qp_12.pdf').series).toBe('Feb/March');
    expect(parseFileName('my-physics_notes.pdf')).toEqual({ title: 'My physics notes', group: [] });
  });
  it('pairs mark schemes with their papers by code, series and number', () => {
    const f = (name: string) => ({ name });
    const r = pairFiles([f('9702_s23_qp_12.pdf'), f('9702_s23_ms_12.pdf'), f('9702_s23_qp_13.pdf'), f('9702_w23_ms_11.pdf')]);
    expect(r.papers.map((p) => [p.qp.name, p.ms?.name])).toEqual([['9702_s23_qp_12.pdf', '9702_s23_ms_12.pdf'], ['9702_s23_qp_13.pdf', undefined]]);
    expect(r.unpaired.map((x) => x.name)).toEqual(['9702_w23_ms_11.pdf']);
  });
  it('default time caps follow the board, otherwise 90 s a question', () => {
    expect(defaultMinutes('9702', '12', 40)).toBe(75);
    expect(defaultMinutes('0625', '22', 40)).toBe(45);
    expect(defaultMinutes(undefined, undefined, 30)).toBe(45);
  });
});

async function importBare(key?: string) {
  const { text, source } = bareImport(
    [{ id: '9702-s23-12', title: 'May/June 2023 Paper 12', group: ['2023', 'May/June'], questionCount: 4, timeLimitMin: 75, optionCount: 4, qp: new Blob([questionPaperPdf(4) as BlobPart]), ms: new Blob([markSchemePdf('BCDA') as BlobPart]), ...(key ? { key: [...key].map((c) => 'ABCD'.indexOf(c)) } : {}) }],
    { title: 'Physics 9702', subject: 'Physics' },
  );
  const parsed = parseImport(text, new Set(source.pdfs.keys()));
  if (!parsed.ok) throw new Error(parsed.syntax);
  expect(parsed.result.errors).toEqual([]);
  const target = { packId: null, newPack: { title: 'Physics 9702', subject: 'Physics' } };
  const { merge, images } = await planImport(parsed.result.doc, target, source, {});
  return commitImport(target, merge, images);
}

describe('bare PDF papers and snips', () => {
  it('imports PDFs with a key through the normal pipeline; questions are Exam-only from the PDF until snipped', async () => {
    const id = await importBare('BCDA');
    const pack = (await store.getPack(id))!;
    expect(pack.papers[0]).toMatchObject({ bare: true, present: 4, keyed: 4 });
    expect((await (await store.db()).getAll('pdfs')).length).toBe(2);
    const { papers } = await loadPackContent(id);
    expect(papers[0]!.questions[0]!.pdfId).toBe(pack.papers[0]!.pdf!.qp);
    expect(poolOf(papers, new Map())).toHaveLength(0);
    await expect(createSession({ pack, type: 'paper', mode: 'exam', paperId: '9702-s23-12' })).resolves.toBeTruthy();
  });
  it('a fully snipped paper joins Random; export and re-import carry PDFs and snips', async () => {
    const id = await importBare('BCDA');
    const pack = (await store.getPack(id))!;
    const qp = pack.papers[0]!.pdf!.qp!;
    for (let q = 1; q <= 3; q++) await store.putSnip({ key: `${id}::9702-s23-12#${q}`, packId: id, qid: `9702-s23-12#${q}`, pdfId: qp, page: 1, x: 0, y: (q - 1) * 0.2, w: 1, h: 0.2, updatedAt: 1 });
    expect(poolOf((await loadPackContent(id)).papers, new Map())).toHaveLength(0);
    await store.putSnip({ key: `${id}::9702-s23-12#4`, packId: id, qid: '9702-s23-12#4', pdfId: qp, page: 1, x: 0, y: 0.6, w: 1, h: 0.2, updatedAt: 1 });
    expect(poolOf((await loadPackContent(id)).papers, new Map())).toHaveLength(4);
    const zip = await exportPackZip(pack, await store.getPapers(id), [], await store.getSnips(id));
    const src = await readZip(zip.blob, zip.name);
    expect([...src.pdfs.keys()]).toHaveLength(2);
    const parsed = parseImport(src.text!, new Set(src.pdfs.keys()));
    if (!parsed.ok) throw new Error(parsed.syntax);
    expect(parsed.result.errors).toEqual([]);
    expect(parsed.result.doc.papers[0]!.questions.filter((q) => q.snip)).toHaveLength(4);
    store.useDbName(`v2f-fresh-${n}`);
    const target = { packId: null, newPack: { title: 'Copy', subject: '' } };
    const { merge, images } = await planImport(parsed.result.doc, target, src, {});
    const id2 = await commitImport(target, merge, images);
    expect(await store.getSnips(id2)).toHaveLength(4);
    expect(poolOf((await loadPackContent(id2)).papers, new Map())).toHaveLength(4);
  });
  it('a full backup round-trips PDFs and snips, and labels library packs private', async () => {
    const id = await importBare('BCDA');
    const pack = (await store.getPack(id))!;
    await store.putPack({ ...pack, origin: { kind: 'library', setId: 'set-1' } });
    await store.putSnip({ key: `${id}::9702-s23-12#1`, packId: id, qid: '9702-s23-12#1', pdfId: pack.papers[0]!.pdf!.qp!, page: 1, x: 0, y: 0, w: 1, h: 0.5, updatedAt: 5 });
    const b = await createBackup('everything');
    const src = await readZip(b.blob, b.name);
    expect(JSON.parse(src.backup!.manifest).privateLibraryPacks).toEqual([id]);
    store.useDbName(`v2f-restore-${n}`);
    await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images, src.backup!.pdfs));
    expect((await (await store.db()).getAll('pdfs')).length).toBe(2);
    expect(await store.getSnips(id)).toHaveLength(1);
    expect((await store.getPack(id))!.origin).toEqual({ kind: 'library', setId: 'set-1' });
  });
  it('library packs cannot be exported as a pack for friends', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = { ...(await store.getPack(id))!, origin: { kind: 'library' as const, setId: 's1' } };
    await expect(exportPackZip(pack, await store.getPapers(id), [])).rejects.toBeInstanceOf(ShareError);
  });
  it('the validator checks snips and requires the question paper for bare papers', () => {
    const r = validateDoc({ papers: [{ id: 'b', title: 'B', questionCount: 2, bare: true, questions: [{ n: 1, answer: 'A', snip: { page: 1, x: 0.5, y: 0, w: 0.8, h: 0.2 } }] }] });
    expect(r.errors.map((e) => e.path)).toEqual(expect.arrayContaining(['papers[0].pdf.questionPaper', 'papers[0].questions[0].snip']));
  });
});

describe('transcription cross-check', () => {
  const pageText = ['1 A car of mass 1200 kg accelerates at 3.0 m s-2. What is the resultant force? A 400 N B 3600 N C 4000 N D 12000 N'.padEnd(400, ' filler')];
  const paper = (stem: string, options: string[]) => validateDoc({ papers: [{ id: 'p', title: 'P', questionCount: 1, questions: [{ n: 1, stem, options, answer: 'B' }] }] }).doc.papers[0]!;
  it('passes a faithful transcription', () => {
    expect(crossCheck(paper('A car of mass 1200 kg accelerates at 3.0 m s^{-2}. What is the resultant force?', ['400 N', '3600 N', '4000 N', '12000 N']), pageText)).toEqual([]);
  });
  it('flags a question whose numbers are not in the paper', () => {
    const r = crossCheck(paper('A car of mass 1500 kg accelerates at 2.5 m s^{-2}.', ['375 N', '3750 N', '4000 N', '15000 N']), pageText);
    expect(r[0]).toMatchObject({ n: 1, missing: ['1500', '2.5', '375', '3750', '15000'] });
  });
  it('skips scanned PDFs with no text', () => {
    expect(crossCheck(paper('mass 1500 kg 2.5', ['1', '2', '3', '4']), [''])).toEqual([]);
  });
});

describe('CLI validator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmc-cli-'));
  const run = (file: string) => spawnSync(process.execPath, ['tools/validate-pack.mjs', file], { encoding: 'utf8' });
  it('passes a valid pack and fails an invalid one with path-based errors', () => {
    writeFileSync(join(dir, 'good.json'), JSON.stringify(doc(syntheticPaper('p1', 4))));
    const good = run(join(dir, 'good.json'));
    expect(good.status).toBe(0);
    expect(good.stdout).toMatch(/^ok the pack is valid/m);
    const bad = doc({ ...syntheticPaper('p1', 4), questions: syntheticPaper('p1', 4).questions.map((q, i) => (i === 1 ? { ...q, answer: 'F' } : q)) });
    writeFileSync(join(dir, 'bad.json'), '```json\n' + JSON.stringify(bad) + '\n```');
    const r = run(join(dir, 'bad.json'));
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^x papers\[0\]\.questions\[1\]\.answer: /m);
  }, 60_000);
  it('the app-side check reports the same as the CLI', () => {
    const r = checkSource({ name: 'x', text: JSON.stringify(doc(syntheticPaper('p1', 3))), files: new Map(), pdfs: new Map(), skipped: [] });
    expect(r).toMatchObject({ ok: true, papers: [{ id: 'p1', questions: 3, questionCount: 3, keyed: 3, bare: false }] });
  });
});
