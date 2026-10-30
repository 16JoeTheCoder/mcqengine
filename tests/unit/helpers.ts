import { expect } from 'vitest';
import * as store from '../../src/lib/data/db';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import type { SessionDetail } from '../../src/lib/types';

export async function importPack(d: unknown, packId: string | null = null) {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  expect(r.result.errors).toEqual([]);
  const target = { packId, newPack: { title: 'Synthetic Physics', subject: 'Physics' } };
  const { merge, images } = await planImport(r.result.doc, target, null, {});
  expect(merge.conflicts).toEqual([]);
  return commitImport(target, merge, images);
}

/** Answers every question of a stored session; `pick` returns the option index or null. */
export async function answerAll(id: string, pick: (i: number, qid: string) => number | null, opts: { unsure?: (i: number) => boolean } = {}) {
  const d = (await store.getDetail(id)) as SessionDetail;
  const s = (await store.getSession(id))!;
  d.answers.forEach((a, i) => {
    a.choice = pick(i, a.qid);
    a.first = a.choice;
    a.timeMs = 30_000;
    a.unsure = opts.unsure?.(i) ?? false;
  });
  await store.saveSessionState(s, d);
  return d;
}

/** Synthetic key used by tests/fixtures/make.ts: question n has answer n % 4. */
export const synthKey = (qid: string) => Number(qid.split('#')[1]) % 4;
