import { beforeEach, describe, expect, it } from 'vitest';
import { fingerprintOf, similarity } from '../../shared/fingerprint';
import { formatPaperKey, isPaperKey, msKeyOf, paperKeyFromCover, paperKeyFromName, paperKeyTitle, parsePaperKey, qpKeyOf, questionIdOf } from '../../shared/paper-key';
import { applyPaperKeys, matchPaper, matchQuestion, resolvePaperKeys } from '../../src/lib/format/identity';
import type { NDoc } from '../../src/lib/format/validate';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import * as store from '../../src/lib/data/db';
import { backend } from '../../src/lib/backend';
import { doc, syntheticPaper } from '../fixtures/make';
import { importPack } from './helpers';

const KEY = '9702_s24_qp_12';
const words = (seed: number, n: number) => Array.from({ length: n }, (_, i) => `q${((i + 1) * seed * 7919) % 9973}z`).join(' ');
const FP_A = fingerprintOf(words(3, 300))!;
const FP_NEAR = fingerprintOf(`${words(3, 300).split(' ').slice(0, 150).join(' ')} changed words here now ${words(3, 300).split(' ').slice(156).join(' ')}`)!;
const FP_FAR = fingerprintOf(words(11, 300))!;

describe('paperKeyFromName', () => {
  it('reads the canonical Cambridge name', () => expect(paperKeyFromName('9702_s24_qp_12.pdf')).toBe(KEY));
  it('accepts dashes and spaces', () => {
    expect(paperKeyFromName('9702-s24-qp-12.pdf')).toBe(KEY);
    expect(paperKeyFromName('9702 s24 qp 12.pdf')).toBe(KEY);
  });
  it('ignores a browser duplicate suffix', () => expect(paperKeyFromName('9702_s24_qp_12 (1).pdf')).toBe(KEY));
  it('ignores a folder path', () => expect(paperKeyFromName('papers/2024/9702_s24_qp_12.pdf')).toBe(KEY));
  it('accepts uppercase', () => expect(paperKeyFromName('9702_S24_QP_12.PDF')).toBe(KEY));
  it('reads a mark scheme', () => expect(paperKeyFromName('9702_s24_ms_12.pdf')).toBe('9702_s24_ms_12'));
  it('pads a single-digit variant', () => expect(paperKeyFromName('9702_s24_qp_1.pdf')).toBe('9702_s24_qp_01'));
  it('returns null for inserts, reports and random names', () => {
    expect(paperKeyFromName('9702_s24_in_12.pdf')).toBeNull();
    expect(paperKeyFromName('9702_s24_er.pdf')).toBeNull();
    expect(paperKeyFromName('physics notes.pdf')).toBeNull();
    expect(paperKeyFromName('')).toBeNull();
  });
});

describe('paperKeyFromCover', () => {
  it('reads the footer form for each series', () => {
    expect(paperKeyFromCover('This document... 9702/12/M/J/24 © UCLES')).toBe('9702_s24_qp_12');
    expect(paperKeyFromCover('9702/12/F/M/24')).toBe('9702_m24_qp_12');
    expect(paperKeyFromCover('9702/12/O/N/23')).toBe('9702_w23_qp_12');
  });
  it('reads the wording form', () => {
    expect(paperKeyFromCover('PHYSICS 9702/12 Paper 1 Multiple Choice May/June 2024 1 hour 15 minutes')).toBe(KEY);
    expect(paperKeyFromCover('PHYSICS 9702/22 Paper 2 October/November 2023')).toBe('9702_w23_qp_22');
  });
  it('turns MARK SCHEME text into a mark scheme key', () => {
    expect(paperKeyFromCover('Cambridge International AS & A Level PHYSICS 9702/12 MARK SCHEME May/June 2024')).toBe('9702_s24_ms_12');
    expect(paperKeyFromCover('MARK SCHEME 9702/12/M/J/24')).toBe('9702_s24_ms_12');
  });
  it('returns null when ambiguous or incomplete', () => {
    expect(paperKeyFromCover('9702/12 and 9701/12 May/June 2024')).toBeNull();
    expect(paperKeyFromCover('9702/12 May/June 2024 and May/June 2023')).toBeNull();
    expect(paperKeyFromCover('9702/12 Paper 1 2024')).toBeNull();
    expect(paperKeyFromCover('9702/12 Paper 1 May/June')).toBeNull();
    expect(paperKeyFromCover('')).toBeNull();
  });
});

describe('key helpers', () => {
  it('validates, formats and parses', () => {
    expect(isPaperKey(KEY)).toBe(true);
    expect(isPaperKey('9702-s24-12')).toBe(false);
    expect(isPaperKey(42)).toBe(false);
    expect(parsePaperKey(KEY)).toEqual({ syllabus: '9702', series: 's', yy: '24', type: 'qp', variant: '12' });
    expect(parsePaperKey('nope')).toBeNull();
    expect(formatPaperKey({ syllabus: '9702', series: 'w', yy: '23', type: 'ms', variant: '2' })).toBe('9702_w23_ms_02');
  });
  it('converts between qp and ms keys', () => {
    expect(qpKeyOf('9702_s24_ms_12')).toBe(KEY);
    expect(qpKeyOf(KEY)).toBe(KEY);
    expect(msKeyOf(KEY)).toBe('9702_s24_ms_12');
  });
  it('builds question ids and titles', () => {
    expect(questionIdOf(KEY, 7)).toBe('9702_s24_qp_12#7');
    expect(paperKeyTitle(KEY)).toBe('May/June 2024 Paper 12');
    expect(paperKeyTitle('9702_w23_qp_22')).toBe('Oct/Nov 2023 Paper 22');
    expect(paperKeyTitle('9702_m25_qp_42')).toBe('Feb/March 2025 Paper 42');
    expect(paperKeyTitle('junk')).toBe('junk');
  });
});

/** A hand-built NDoc; only the fields the identity code reads matter. */
function nd(papers: Record<string, unknown>[], setId?: string): NDoc {
  return {
    ...(setId ? { pack: { setId } } : {}),
    papers: papers.map((p) => ({ title: p.id as string, group: [], questionCount: 1, timeLimitMin: 10, optionCount: 4, questions: [], ...p })),
    answers: [],
  } as unknown as NDoc;
}
const SET = '11111111-1111-4111-8111-111111111111';

describe('resolvePaperKeys', () => {
  it('uses the question paper PDF name', () => {
    const [r] = resolvePaperKeys(nd([{ id: 'x', pdf: { questionPaper: 'in/9702_s24_qp_12.pdf' } }]));
    expect(r).toMatchObject({ key: KEY, status: 'found', from: 'file name' });
  });
  it('uses source.questionPaper', () => {
    const [r] = resolvePaperKeys(nd([{ id: 'x', source: { questionPaper: '9702_s24_qp_12.pdf' } }]));
    expect(r).toMatchObject({ key: KEY, status: 'found', from: 'file name' });
  });
  it('turns a mark scheme name into the qp key', () => {
    const [r] = resolvePaperKeys(nd([{ id: 'x', source: { markScheme: '9702_s24_ms_12.pdf' } }]));
    expect(r).toMatchObject({ key: KEY, status: 'found' });
  });
  it('uses cover page text keyed by the PDF path', () => {
    const d = nd([{ id: 'x', pdf: { questionPaper: 'scan.pdf' } }]);
    const [r] = resolvePaperKeys(d, new Map([['scan.pdf', 'PHYSICS 9702/12 May/June 2024']]));
    expect(r).toMatchObject({ key: KEY, status: 'found', from: 'cover page' });
  });
  it('uses a confirmed key', () => {
    const [r] = resolvePaperKeys(nd([{ id: 'paper-one' }]), new Map(), { 'paper-one': '9702_s24_ms_12' });
    expect(r).toMatchObject({ key: KEY, status: 'found', from: 'confirmed' });
  });
  it('trusts a canonical id only when the doc carries a set ID', () => {
    expect(resolvePaperKeys(nd([{ id: KEY }], SET))[0]).toMatchObject({ key: KEY, status: 'found', from: 'DMC export' });
    expect(resolvePaperKeys(nd([{ id: KEY }]))[0]!.from).not.toBe('DMC export');
    expect(resolvePaperKeys(nd([{ id: 'legacy' }], SET))[0]!.key).toBeNull();
  });
  it('never trusts an AI-written id: no key, status missing, no suggestion', () => {
    for (const id of ['9702-s24-12', '9702_s24_p12', 'paper-one']) {
      const r = resolvePaperKeys(nd([{ id }]))[0]!;
      expect(r).toMatchObject({ key: null, status: 'missing' });
      expect(r).not.toHaveProperty('suggestion');
    }
  });
  it('carries the fingerprint from a { cover, fingerprint } text and still reads the cover code', () => {
    const d = nd([{ id: 'x', pdf: { questionPaper: 'scan.pdf' } }, { id: 'y', pdf: { questionPaper: 'other.pdf' } }]);
    const r = resolvePaperKeys(d, new Map([['scan.pdf', { cover: 'PHYSICS 9702/12 May/June 2024', fingerprint: FP_A }], ['other.pdf', { cover: '', fingerprint: null }]]));
    expect(r[0]).toMatchObject({ key: KEY, status: 'found', from: 'cover page', fingerprint: FP_A });
    expect(r[1]).toMatchObject({ key: null, status: 'missing' });
    expect(r[1]).not.toHaveProperty('fingerprint');
  });
  it('works on a validated document', () => {
    const p = syntheticPaper('9702-s24-12', 2);
    (p as { source?: unknown }).source = { questionPaper: '9702_s24_qp_12.pdf' };
    const r = parseImport(JSON.stringify(doc(p)));
    if (!r.ok) throw new Error(r.syntax);
    expect(resolvePaperKeys(r.result.doc)[0]).toMatchObject({ key: KEY, status: 'found' });
  });
});

describe('applyPaperKeys', () => {
  it('renames the paper and its answer keys to the key', () => {
    const d = nd([{ id: '9702-s24-12', source: { questionPaper: '9702_s24_qp_12.pdf' } }]);
    d.answers.push({ paper: '9702-s24-12', key: [0], path: 'answers[0]' });
    const map = applyPaperKeys(d, resolvePaperKeys(d), []);
    expect(map.get('9702-s24-12')).toBe(KEY);
    expect(d.papers[0]!.id).toBe(KEY);
    expect(d.papers[0]!.key).toBe(KEY);
    expect(d.answers[0]!.paper).toBe(KEY);
  });
  it('reuses an existing legacy id whose paperKey matches', () => {
    const d = nd([{ id: 'new-id', source: { questionPaper: '9702_s24_qp_12.pdf' } }]);
    d.answers.push({ paper: 'new-id', key: [0], path: 'answers[0]' });
    applyPaperKeys(d, resolvePaperKeys(d), [{ id: 'legacy-1', paperKey: KEY }]);
    expect(d.papers[0]!.id).toBe('legacy-1');
    expect(d.answers[0]!.paper).toBe('legacy-1');
  });
  it('renames a paper without a key to an existing paper with a matching fingerprint', () => {
    expect(similarity(FP_A, FP_NEAR)).toBeGreaterThanOrEqual(0.9);
    const d = nd([{ id: 'scan-1' }]);
    d.answers.push({ paper: 'scan-1', key: [0], path: 'answers[0]' });
    const map = applyPaperKeys(d, [{ docId: 'scan-1', title: 'scan-1', key: null, status: 'missing', fingerprint: FP_NEAR }], [{ id: 'old-paper', fingerprint: FP_A }]);
    expect(map.get('scan-1')).toBe('old-paper');
    expect(d.papers[0]!.id).toBe('old-paper');
    expect(d.answers[0]!.paper).toBe('old-paper');
    expect(d.papers[0]!.fingerprint).toBe(FP_NEAR);
    expect(d.papers[0]!.key).toBeUndefined();
  });
  it('does not match by fingerprint below the threshold', () => {
    expect(similarity(FP_A, FP_FAR)).toBeLessThan(0.9);
    const d = nd([{ id: 'scan-1' }]);
    const map = applyPaperKeys(d, [{ docId: 'scan-1', title: 'scan-1', key: null, status: 'missing', fingerprint: FP_FAR }], [{ id: 'old-paper', fingerprint: FP_A }]);
    expect(map.size).toBe(0);
    expect(d.papers[0]!.id).toBe('scan-1');
  });
  it('leaves unresolved papers alone', () => {
    const d = nd([{ id: 'paper-one' }]);
    const map = applyPaperKeys(d, resolvePaperKeys(d), []);
    expect(map.size).toBe(0);
    expect(d.papers[0]!.id).toBe('paper-one');
  });
});

describe('matchQuestion and matchPaper', () => {
  it('classifies questions', () => {
    expect(matchQuestion(undefined, { hash: 'a' })).toBe('new');
    expect(matchQuestion({ hash: 'a' }, { hash: 'a' })).toBe('same');
    expect(matchQuestion({ hash: 'a' }, { hash: 'b' })).toBe('changed');
  });
  it('matches papers by key first, then id', () => {
    const locals = [{ id: 'old', paperKey: KEY }, { id: 'other' }];
    expect(matchPaper(locals, { id: 'zzz', paperKey: KEY })).toBe(locals[0]);
    expect(matchPaper(locals, { id: 'other' })).toBe(locals[1]);
    expect(matchPaper(locals, { id: KEY, paperKey: KEY })).toBe(locals[0]);
    expect(matchPaper(locals, { id: 'none' })).toBeUndefined();
  });
});

let n = 0;
beforeEach(async () => { store.useDbName(`identity-${++n}`); indexedDB.deleteDatabase('dmc-mock-server'); await backend!.signOut(); });

const keyed = (id: string, count = 4, stem?: { n: number; text: string }) => {
  const p = syntheticPaper(id, count);
  (p as { source?: unknown }).source = { questionPaper: `${id}.pdf` };
  if (stem) p.questions.find((q) => q.n === stem.n)!.stem = stem.text;
  return p;
};
const parse = (d: unknown) => {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  return r.result.doc;
};
const newPack = { packId: null, newPack: { title: 'T', subject: 'Physics' } };
const stemOf = async (packId: string, n: number) => (await store.getPapers(packId))[0]!.questions.find((q) => q.n === n)!.stem;

describe('mergeDoc through import', () => {
  it('importing identical content twice adds nothing', async () => {
    const id = await importPack(doc(keyed(KEY)));
    const plan = await planImport(parse(doc(keyed(KEY))), { packId: id }, null, {});
    expect(plan.merge.conflicts).toEqual([]);
    expect(plan.merge.changed).toEqual([]);
    expect(plan.merge.plan[0]).toMatchObject({ status: 'identical', added: 0, unchanged: 4 });
    await commitImport({ packId: id }, plan.merge, plan.images);
    const papers = await store.getPapers(id);
    expect(papers.length).toBe(1);
    expect(papers[0]!.questions.length).toBe(4);
  });
  const edited = () => doc(keyed(KEY, 4, { n: 2, text: 'A different stem' }));
  it('an edited stem is a conflict and is listed in changed', async () => {
    const id = await importPack(doc(keyed(KEY)));
    const { merge } = await planImport(parse(edited()), { packId: id }, null, {});
    expect(merge.conflicts.length).toBe(1);
    expect(merge.changed).toEqual([{ paperId: KEY, n: 2 }]);
  });
  it("prefer 'mine' keeps the old stem", async () => {
    const id = await importPack(doc(keyed(KEY)));
    const old = await stemOf(id, 2);
    const { merge, images } = await planImport(parse(edited()), { packId: id }, null, {}, { prefer: 'mine' });
    expect(merge.conflicts).toEqual([]);
    expect(merge.changed).toEqual([{ paperId: KEY, n: 2 }]);
    await commitImport({ packId: id }, merge, images);
    expect(await stemOf(id, 2)).toBe(old);
  });
  it("prefer 'theirs' takes the new stem", async () => {
    const id = await importPack(doc(keyed(KEY)));
    const { merge, images } = await planImport(parse(edited()), { packId: id }, null, {}, { prefer: 'theirs' });
    expect(merge.conflicts).toEqual([]);
    await commitImport({ packId: id }, merge, images);
    expect(await stemOf(id, 2)).toBe('A different stem');
    expect((await store.getPapers(id))[0]!.questions.length).toBe(4);
  });
});

describe('set identity on import', () => {
  const withSet = (setId: string | undefined, p = keyed(KEY)) => ({ ...doc(p), ...(setId ? { pack: { title: 'Set', subject: 'Physics', setId } } : {}) });
  const run = async (d: unknown, target: Parameters<typeof planImport>[1]) => {
    const { merge, images, target: t } = await planImport(parse(d), target, null, {});
    return commitImport(t, merge, images);
  };
  it('lands in the pack with the same setId even when a new pack is requested', async () => {
    const first = await run(withSet(SET), newPack);
    const second = await run(withSet(SET, keyed('9702_s24_qp_22')), newPack);
    expect(second).toBe(first);
    expect((await store.getPacks()).length).toBe(1);
    expect((await store.getPapers(first)).length).toBe(2);
  });
  it('creates a pack carrying a new setId', async () => {
    const id = await run(withSet(SET), newPack);
    expect((await store.getPack(id))!.setId).toBe(SET);
    const other = await run(withSet('22222222-2222-4222-8222-222222222222'), newPack);
    expect(other).not.toBe(id);
    expect((await store.getPacks()).length).toBe(2);
  });
  it('gives a document without a setId a fresh UUID', async () => {
    const a = await run(withSet(undefined), newPack);
    const b = await run(withSet(undefined), newPack);
    const sa = (await store.getPack(a))!.setId;
    const sb = (await store.getPack(b))!.setId;
    expect(sa).toMatch(/^[0-9a-f-]{36}$/);
    expect(sb).toMatch(/^[0-9a-f-]{36}$/);
    expect(sa).not.toBe(sb);
  });
});
