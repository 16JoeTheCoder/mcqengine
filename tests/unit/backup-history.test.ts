import { Blob as NodeBlob } from 'node:buffer';
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/lib/data/db';
import { applyRestore, BACKUP_FORMAT, createBackup, planRestore, readProgressJson, validRow } from '../../src/lib/data/backup';
import { readZip, sha256Hex } from '../../src/lib/data/files';
import { createSession, submitSession } from '../../src/lib/engine/session';
import { regradePack } from '../../src/lib/engine/regrade';
import { doc, syntheticPaper } from '../fixtures/make';
import { answerAll, importPack, synthKey } from './helpers';

(globalThis as { Blob: unknown }).Blob = NodeBlob;
let n = 0;
beforeEach(() => store.useDbName(`backup-history-${++n}`));

async function asset(bytes: string, pdf = false) {
  const blob = new Blob([bytes], { type: pdf ? 'application/pdf' : 'image/png' });
  const id = await sha256Hex(await blob.arrayBuffer());
  const d = await store.db();
  if (pdf) await d.put('pdfs', { id, blob, name: `${id}.pdf`, size: blob.size, addedAt: 1 });
  else await d.put('images', { id, blob, type: blob.type });
  return id;
}

async function attach(packId: string, image: string, pdf: string, shared?: string) {
  const paper = (await store.getPapers(packId))[0]!;
  paper.questions[0] = { ...paper.questions[0]!, image, ...(shared ? { figure: { kind: 'image', imageId: shared } } : {}) };
  paper.pdf = { qp: pdf };
  await (await store.db()).put('papers', paper);
}

describe('bounded backups and content isolation', () => {
  it('includes only assets referenced by included content, retaining shared assets', async () => {
    const personal = await importPack(doc(syntheticPaper('personal', 2)));
    const library = await importPack(doc(syntheticPaper('library', 2)));
    await store.putPack({ ...(await store.getPack(library))!, origin: { kind: 'library', setId: 'private' } });
    const shared = await asset('shared');
    const personalImage = await asset('personal');
    const privateImage = await asset('private');
    const unused = await asset('unused');
    const personalPdf = await asset('%PDF-personal', true);
    const privatePdf = await asset('%PDF-private', true);
    await attach(personal, personalImage, personalPdf, shared);
    await attach(library, privateImage, privatePdf, shared);
    const { blob, name } = await createBackup('everything', 1, { excludeLibrary: true });
    const backup = (await readZip(blob, name)).backup!;
    expect([...backup.images.keys()].sort()).toEqual([personalImage, shared].sort());
    expect(backup.images.has(privateImage)).toBe(false);
    expect(backup.images.has(unused)).toBe(false);
    expect([...backup.pdfs.keys()]).toEqual([personalPdf]);
    expect(JSON.parse(backup.data).packs.map((p: { id: string }) => p.id)).toEqual([personal]);
  });

  it('also removes Library progress when the tier contains no pack rows', async () => {
    const packId = await importPack(doc(syntheticPaper('p', 2)));
    const pack = { ...(await store.getPack(packId))!, origin: { kind: 'library' as const, setId: 'private' } };
    await store.putPack(pack);
    await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p' });
    const { blob } = await createBackup('progress', 1, { excludeLibrary: true });
    expect(JSON.parse(readProgressJson(await blob.text())!.data).sessions).toEqual([]);
  });

  it('preserves legacy Daily 10 records through backup and restore', async () => {
    const packId = await importPack(doc(syntheticPaper('p', 2)));
    const pack = (await store.getPack(packId))!;
    const { summary, detail } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p' });
    await store.saveSessionState({ ...summary, type: 'daily', status: 'submitted' }, detail);
    const { blob } = await createBackup('everything');
    const backup = (await readZip(blob, 'legacy.zip')).backup!;
    await store.wipeAll();
    await applyRestore(await planRestore(backup.manifest, backup.data, backup.images, backup.pdfs));
    expect((await store.getSession(summary.id))!.type).toBe('daily');
  });

  it('rejects oversized JSON and prototype-named tiers before writing', async () => {
    const manifest = { format: BACKUP_FORMAT, tier: '__proto__', checksum: await sha256Hex('{}') };
    await expect(planRestore(JSON.stringify(manifest), '{}', new Map())).rejects.toThrow('Unknown backup type');
    await expect(planRestore('{}', ' '.repeat(15_000_001), new Map())).rejects.toThrow('15 MB');
  });
});

describe('historical question content and regrades', () => {
  it('retains the content answered and an audit of every changed key and resulting score', async () => {
    const packId = await importPack(doc(syntheticPaper('p', 2)));
    const pack = (await store.getPack(packId))!;
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p' });
    await answerAll(summary.id, (_i, qid) => synthKey(qid));
    await submitSession(summary.id, false, 100);
    const original = (await store.getDetail(summary.id))!.snapshots![0]!.stem;
    const paper = (await store.getPapers(packId))[0]!;
    paper.questions[0]!.stem = 'A replacement question';
    paper.questions[0]!.answer = 0;
    await (await store.db()).put('papers', paper);
    await regradePack(packId, 200);
    const changed = (await store.getDetail(summary.id))!;
    expect(changed.snapshots![0]!.stem).toBe(original);
    expect(changed.regrades).toEqual([{ at: 200, previousKey: [1, 2], key: [0, 2], previousCorrect: 2, correct: 1 }]);
    await regradePack(packId, 300);
    expect((await store.getDetail(summary.id))!.regrades).toHaveLength(1);
    const { blob, name } = await createBackup('everything');
    const backup = (await readZip(blob, name)).backup!;
    await store.wipeAll();
    await applyRestore(await planRestore(backup.manifest, backup.data, backup.images, backup.pdfs));
    expect((await store.getDetail(summary.id))!.regrades).toEqual(changed.regrades);
    expect((await store.getDetail(summary.id))!.snapshots).toEqual(changed.snapshots);
  });

  it('rejects invalid content and regrade keys in restored snapshots', () => {
    const detail = { id: 's', packId: 'p', questionIds: ['q#1'], answers: [{ qid: 'q#1', choice: 0, timeMs: 1 }] };
    expect(validRow('sessionDetail', detail)).toBe(true); // older backups remain readable
    expect(validRow('sessionDetail', { ...detail, snapshots: [{ id: 'q#1', n: 1, optionCount: 4, answer: 9 }] })).toBe(false);
    expect(validRow('sessionDetail', { ...detail, regrades: [{ at: 1, previousKey: [0], key: [9], previousCorrect: 1, correct: 0 }] })).toBe(false);
  });
});
