import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/lib/data/db';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { applyRestore, createBackup, planRestore, readProgressJson, BackupError } from '../../src/lib/data/backup';
import { readZip } from '../../src/lib/data/files';
import { createSession, submitSession } from '../../src/lib/engine/session';
import { doc, syntheticPaper } from '../fixtures/make';
import type { SessionDetail } from '../../src/lib/types';

let n = 0;
beforeEach(() => {
  store.useDbName(`test-${++n}`);
});

async function importPack(d: unknown, packId: string | null = null) {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  expect(r.result.errors).toEqual([]);
  const target = { packId, newPack: { title: 'Synthetic Physics', subject: 'Physics' } };
  const { merge, images } = await planImport(r.result.doc, target, null, {});
  expect(merge.conflicts).toEqual([]);
  return commitImport(target, merge, images);
}

async function answerAll(id: string, pick: (i: number) => number | null) {
  const d = (await store.getDetail(id)) as SessionDetail;
  const s = (await store.getSession(id))!;
  d.answers.forEach((a, i) => {
    a.choice = pick(i);
    a.first = a.choice;
    a.timeMs = 30_000;
  });
  await store.saveSessionState(s, d);
  return d;
}

async function snapshot() {
  const d = await store.db();
  const out: Record<string, unknown> = {};
  for (const s of store.STORES) {
    if (s === 'meta') out[s] = await d.get('meta', 'settings');
    else if (s === 'images') out[s] = (await d.getAll('images')).map((i) => [i.id, i.type, i.blob.size]);
    else out[s] = await d.getAll(s as never);
  }
  return JSON.parse(JSON.stringify(out));
}

describe('import and pack storage', () => {
  it('imports a new pack, then adds papers and merges chunks', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    expect(pack.title).toBe('Synthetic Physics');
    expect(pack.papers).toHaveLength(1);
    await importPack(doc(syntheticPaper('p2', 4, { from: 1, to: 2 })), id);
    await importPack(doc(syntheticPaper('p2', 4, { from: 3, to: 4 })), id);
    const p2 = (await store.getPack(id))!.papers.find((p) => p.id === 'p2')!;
    expect(p2.present).toBe(4);
    expect(p2.keyed).toBe(4);
  });
  it('an unkeyed paper cannot be started until keyed', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4, { answers: false })));
    const pack = (await store.getPack(id))!;
    await expect(createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' })).rejects.toThrow(/not complete or not fully keyed/);
    await importPack({ answers: [{ paper: 'p1', key: 'ABCD' }] }, id);
    const keyed = (await store.getPack(id))!;
    await expect(createSession({ pack: keyed, type: 'paper', mode: 'exam', paperId: 'p1' })).resolves.toBeTruthy();
  });
});

describe('session lifecycle', () => {
  it('submit partial: only answered graded, unanswered stay unseen, double submit is a no-op', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', timer: { kind: 'total', minutes: 999 } });
    expect(summary.timer!.totalMs).toBe(60 * 60_000);
    // Synthetic key: answer index = n % 4 -> q1 B, q2 C.
    await answerAll(summary.id, (i) => (i < 2 ? (i + 1) % 4 : null));
    const r = (await submitSession(summary.id, false))!;
    expect(r.summary.partial).toBe(true);
    expect(r.summary.answered).toBe(2);
    expect(r.summary.correct).toBe(2);
    const stats = await store.getStats(id);
    expect(stats).toHaveLength(2);
    expect(stats.every((s) => s.timesSeen === 1)).toBe(true);
    const again = await submitSession(summary.id, false);
    expect(again!.summary.endedAt).toBe(r.summary.endedAt);
    expect(await store.getStats(id)).toHaveLength(2);
  });

  it('random sessions exhaust unseen questions first and drills fill from the bank', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4), syntheticPaper('p3', 4)));
    const pack = (await store.getPack(id))!;
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const { summary, detail } = await createSession({ pack, type: 'random', mode: 'practice' });
      expect(detail.questionIds).toHaveLength(4);
      detail.questionIds.forEach((q) => {
        expect(seen.has(q)).toBe(false);
        seen.add(q);
      });
      await answerAll(summary.id, () => 0); // A: correct only where n % 4 == 0
      await submitSession(summary.id, false);
    }
    expect(seen.size).toBe(12);
    const stats = await store.getStats(id);
    expect(stats.filter((s) => s.inBank)).toHaveLength(9);
    const drill = await createSession({ pack, type: 'drill', mode: 'exam' });
    expect(drill.detail.questionIds).toHaveLength(4);
    expect(drill.summary.timer!.kind).toBe('total');
    await answerAll(drill.summary.id, () => null);
    await submitSession(drill.summary.id, false);
    // Drill does not change timesSeen.
    expect((await store.getStats(id)).every((s) => s.timesSeen === 1)).toBe(true);
  });

  it('a saved session blocks a second session in the same pack', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)));
    const pack = (await store.getPack(id))!;
    const a = await createSession({ pack, type: 'random', mode: 'exam' });
    const s = (await store.getSession(a.summary.id))!;
    await store.saveSessionState({ ...s, status: 'saved' }, a.detail);
    // One open session per pack: the engine refuses a second, so locked questions are never shared.
    await expect(createSession({ pack, type: 'random', mode: 'exam' })).rejects.toThrow(/saved session/);
  });
});

describe('backup round-trip', () => {
  it('export everything, wipe, import reproduces identical state', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)));
    const pack = (await store.getPack(id))!;
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await answerAll(summary.id, () => 1);
    await submitSession(summary.id, false);
    await store.putSettings({ ...(await store.getSettings()), examDate: '2026-11-10' });
    const before = await snapshot();

    const { blob } = await createBackup('everything');
    await store.wipeAll();
    expect((await snapshot()).packs).toEqual([]);
    const src = await readZip(blob, 'backup.zip');
    expect(src.backup).toBeTruthy();
    const plan = await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images);
    expect(plan.adds.packs).toBe(1);
    expect(plan.adds.sessions).toBe(1);
    await applyRestore(plan);
    expect(await snapshot()).toEqual(before);

    // Importing again changes nothing (merge by id and updatedAt).
    const plan2 = await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images);
    expect(Object.keys(plan2.adds)).toEqual([]);
    expect(Object.keys(plan2.merges)).toEqual([]);
  });

  it('progress backup is JSON and verifies its checksum', async () => {
    await importPack(doc(syntheticPaper('p1', 4)));
    const { blob } = await createBackup('progress');
    const text = await blob.text();
    const parsed = readProgressJson(text)!;
    await expect(planRestore(parsed.manifest, parsed.data, new Map())).resolves.toBeTruthy();
    await expect(planRestore(parsed.manifest, parsed.data.replace('}', ' }'), new Map())).rejects.toBeInstanceOf(BackupError);
  });
});
