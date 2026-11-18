import { beforeEach, describe, expect, it } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import { strToU8, zipSync } from 'fflate';
import * as store from '../../src/lib/data/db';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { readZip } from '../../src/lib/data/files';
import { createSession, paperViews, submitSession } from '../../src/lib/engine/session';
import { doc, syntheticPaper } from '../fixtures/make';
import { answerAll, importPack, synthKey } from './helpers';

// happy-dom's Blob does not survive fake-indexeddb's structured clone; Node's does.
(globalThis as { Blob: unknown }).Blob = NodeBlob;

let n = 0;
beforeEach(() => store.useDbName(`modes-${++n}`));

const PDF = new TextEncoder().encode('%PDF-1.7\n% synthetic question paper\n');

/** Imports a pack zip; papers in pdfPaperIds carry a question paper PDF, those in bareIds are bare. */
async function importWithPdf(papers: unknown[], pdfPaperIds: string[], bareIds: string[] = []) {
  const d = doc(...papers) as { papers: Record<string, unknown>[] };
  for (const p of d.papers) {
    if (pdfPaperIds.includes(p.id as string)) p.pdf = { questionPaper: `pdfs/${p.id}.pdf` };
    if (bareIds.includes(p.id as string)) p.bare = true;
  }
  const entries: Record<string, Uint8Array> = { 'pack.json': strToU8(JSON.stringify(d)) };
  for (const id of pdfPaperIds) entries[`pdfs/${id}.pdf`] = PDF;
  const src = await readZip(new Blob([zipSync(entries)]), 'x.zip');
  const r = parseImport(src.text!, new Set([...src.files.keys(), ...src.pdfs.keys()]));
  if (!r.ok) throw new Error(r.syntax);
  expect(r.result.errors).toEqual([]);
  const target = { packId: null, newPack: { title: 'Modes', subject: 'Physics' } };
  const { merge, images } = await planImport(r.result.doc, target, src, {});
  return commitImport(target, merge, images);
}
const packOf = async (id: string) => (await store.getPack(id))!;

describe('paperViews', () => {
  it('typed paper without a question paper PDF offers DMC only', () => {
    expect(paperViews({}, true)).toEqual(['dmc']);
  });
  it('typed paper with a question paper PDF offers DMC and PDF', () => {
    expect(paperViews({ pdf: { qp: 'a'.repeat(64) } }, true)).toEqual(['dmc', 'pdf']);
    // A mark scheme alone does not enable PDF mode.
    expect(paperViews({ pdf: { ms: 'b'.repeat(64) } }, true)).toEqual(['dmc']);
  });
  it('bare paper offers PDF only, and nothing without a PDF', () => {
    expect(paperViews({ bare: true, pdf: { qp: 'a'.repeat(64) } }, true)).toEqual(['pdf']);
    expect(paperViews({ bare: true }, true)).toEqual([]);
  });
  it('a paper whose questions cannot be shown on their own behaves like a bare paper', () => {
    expect(paperViews({ pdf: { qp: 'a'.repeat(64) } }, false)).toEqual(['pdf']);
    expect(paperViews({}, false)).toEqual([]);
  });
});

describe('createSession with a view', () => {
  it('PDF mode needs the PDF; DMC mode needs typed questions', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 4), syntheticPaper('p2', 4)], ['p1']);
    const pack = await packOf(id);
    expect(pack.papers.find((p) => p.id === 'p1')!.pdf?.qp).toMatch(/^[0-9a-f]{64}$/);
    expect(pack.papers.find((p) => p.id === 'p2')!.pdf).toBeUndefined();
    await expect(createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p2', view: 'pdf' })).rejects.toThrow(/PDF/);
    expect(await store.getOpenSessions()).toEqual([]);
  });

  it('DMC view on a bare paper throws', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 4)], ['p1'], ['p1']);
    const pack = await packOf(id);
    expect(pack.papers[0]!.bare).toBe(true);
    await expect(createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', view: 'dmc' })).rejects.toThrow(/PDF mode/);
  });

  it('PDF view is stored and never shuffles, in printed order', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 12)], ['p1']);
    const pack = await packOf(id);
    const { detail } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', view: 'pdf', shuffle: true });
    expect(detail.view).toBe('pdf');
    expect(detail.shuffled).toBe(false);
    expect(detail.questionIds).toEqual(Array.from({ length: 12 }, (_, i) => `p1#${i + 1}`));
    expect((await store.getDetail(detail.id))!.view).toBe('pdf');
  });

  it('a bare paper defaults to PDF view', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 4)], ['p1'], ['p1']);
    const { detail } = await createSession({ pack: await packOf(id), type: 'paper', mode: 'exam', paperId: 'p1' });
    expect(detail.view).toBe('pdf');
  });

  it('the default for a typed paper is DMC, with no view stored, even when a PDF exists', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 4)], ['p1']);
    const pack = await packOf(id);
    const { detail } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    expect('view' in detail).toBe(false);
    expect(detail.shuffled).toBe(false);
  });

  it('explicit DMC view stores no view field, and shuffle applies', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 30)], ['p1']);
    const { detail } = await createSession({ pack: await packOf(id), type: 'paper', mode: 'exam', paperId: 'p1', view: 'dmc', shuffle: true });
    expect('view' in detail).toBe(false);
    expect(detail.shuffled).toBe(true);
    expect([...detail.questionIds].sort()).toEqual(Array.from({ length: 30 }, (_, i) => `p1#${i + 1}`).sort());
  });
});

describe('grading is identical in both modes', () => {
  // Same answers: question n picks the key for n, except every third which is wrong; one skipped.
  const pick = (i: number, qid: string) => (i === 5 ? null : i % 3 === 0 ? (synthKey(qid) + 1) % 4 : synthKey(qid));

  async function run(view: 'dmc' | 'pdf') {
    store.useDbName(`modes-run-${view}-${++n}`);
    const id = await importWithPdf([syntheticPaper('p1', 12)], ['p1']);
    const { summary } = await createSession({ pack: await packOf(id), type: 'paper', mode: 'exam', paperId: 'p1', view });
    await answerAll(summary.id, pick);
    const done = (await submitSession(summary.id, false, 1_000_000))!;
    const stats = (await store.getStats(id)).map(({ key: _k, packId: _p, ...rest }) => rest);
    return { done, stats: stats.sort((a, b) => a.qid.localeCompare(b.qid, undefined, { numeric: true })) };
  }

  it('same correct count, aggregate and question stats', async () => {
    const dmc = await run('dmc');
    const pdf = await run('pdf');
    expect(dmc.done.summary.correct).toBeGreaterThan(0);
    expect(pdf.done.summary.correct).toBe(dmc.done.summary.correct);
    expect(pdf.done.summary.answered).toBe(dmc.done.summary.answered);
    expect(pdf.done.summary.partial).toBe(dmc.done.summary.partial);
    expect(pdf.done.grade.correct).toBe(dmc.done.grade.correct);
    expect(pdf.done.grade.items.map((x) => [x.qid, x.correct])).toEqual(dmc.done.grade.items.map((x) => [x.qid, x.correct]));
    expect(pdf.stats).toEqual(dmc.stats);
    expect(pdf.stats.length).toBeGreaterThan(0);
  });
});

describe('random and drill sessions ignore view', () => {
  it('store no view even when asked for pdf', async () => {
    const id = await importWithPdf([syntheticPaper('p1', 8), syntheticPaper('p2', 8)], ['p1', 'p2']);
    const pack = await packOf(id);
    const r = await createSession({ pack, type: 'random', mode: 'exam', view: 'pdf' });
    expect('view' in r.detail).toBe(false);
    expect(r.detail.shuffled).toBe(true);
    await submitSession(r.summary.id, true);

    // Make a mistake so a drill has something to draw.
    const p = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await answerAll(p.summary.id, (_i, q) => (synthKey(q) + 1) % 4);
    await submitSession(p.summary.id, false);
    const d = await createSession({ pack: await packOf(id), type: 'drill', mode: 'exam', view: 'pdf' });
    expect('view' in d.detail).toBe(false);
    expect(d.detail.shuffled).toBe(true);
  });
});

// A typed-only pack imported without PDFs still works through the shared helper.
describe('no PDF at all', () => {
  it('typed pack offers DMC only and rejects PDF view', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = await packOf(id);
    await expect(createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', view: 'pdf' })).rejects.toThrow(/PDF mode needs/);
    const { detail } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', view: 'dmc' });
    expect('view' in detail).toBe(false);
  });
});
