import { metaOf } from '../format/merge';
import { regradePack } from '../engine/regrade';
import type { GradeBoundary, Paper } from '../types';
import * as store from './db';

/**
 * Sets a paper's answer key (from a typed string, a file, a confirmed mark-scheme grid or the
 * mark-myself grid). `null` entries leave a question unkeyed. The key becomes the official one:
 * answer fixes stored as overrides for these questions are dropped so the new key wins. Every
 * session graded with the old key, or waiting for one, is regraded. Returns sessions regraded.
 */
export async function setPaperKey(packId: string, paperId: string, key: (number | null)[], now = Date.now()): Promise<number> {
  await store.write(async () => {
    const d = await store.db();
    const tx = d.transaction(['packs', 'papers', 'overrides'], 'readwrite');
    const paper = await tx.objectStore('papers').get(`${packId}::${paperId}`);
    const pack = await tx.objectStore('packs').get(packId);
    if (!paper || !pack) throw new Error('Paper not found');
    if (key.length !== paper.questionCount) throw new Error(`The key has ${key.length} answers; the paper has ${paper.questionCount} questions`);
    if (key.some((k) => k !== null && (k < 0 || k >= paper.optionCount))) throw new Error(`Every answer must be one of the ${paper.optionCount} options`);
    const next: Paper = { ...paper, pendingKey: key, questions: paper.questions.map((q) => ({ ...q, answer: key[q.n - 1] ?? null })) };
    for (const q of next.questions) {
      const ok = `${packId}::${q.id}`;
      const ov = await tx.objectStore('overrides').get(ok);
      if (ov && ov.answer !== undefined) {
        const { answer: _a, ...rest } = ov;
        await tx.objectStore('overrides').put({ ...rest, updatedAt: now });
      }
    }
    await tx.objectStore('papers').put({ ...next, ...metaOf(next) });
    const keyed = next.questions.filter((q) => q.answer !== null).length;
    await tx.objectStore('packs').put({ ...pack, papers: pack.papers.map((m) => (m.id === paperId ? { ...m, keyed } : m)), updatedAt: now });
    await tx.done;
  });
  return regradePack(packId, now);
}

export async function setPaperBoundaries(packId: string, paperId: string, boundaries: GradeBoundary[], now = Date.now()) {
  await store.write(async () => {
    const tx = (await store.db()).transaction(['packs', 'papers'], 'readwrite');
    const paper = await tx.objectStore('papers').get(`${packId}::${paperId}`);
    const pack = await tx.objectStore('packs').get(packId);
    if (!paper || !pack) throw new Error('Paper not found');
    const next: Paper = { ...paper, boundaries: boundaries.slice().sort((a, b) => b.min - a.min) };
    if (!boundaries.length) delete next.boundaries;
    await tx.objectStore('papers').put(next);
    const patch = (m: (typeof pack.papers)[number]) => {
      const { boundaries: _b, ...rest } = m;
      return next.boundaries ? { ...rest, boundaries: next.boundaries } : rest;
    };
    await tx.objectStore('packs').put({ ...pack, papers: pack.papers.map((m) => (m.id === paperId ? patch(m) : m)), updatedAt: now });
    await tx.done;
  });
}
