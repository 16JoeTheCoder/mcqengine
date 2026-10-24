// Audit (logic round 2): regressions and gaps in the round-1 fixes.
// Tests titled "regression (was a bug)" describe bugs the audits found; they now guard the fixes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { h } from 'preact';
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { act } from 'preact/test-utils';
import * as store from '../../src/lib/data/db';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { applyRestore, createBackup, planRestore, readProgressJson } from '../../src/lib/data/backup';
import { readZip, sha256Hex } from '../../src/lib/data/files';
import { createSession, loadPackContent, submitSession } from '../../src/lib/engine/session';
import { sanitizeTimer } from '../../src/lib/engine/timer';
import { finalWrite, setFinalWrite } from '../../src/lib/tablock';
import { papersDone, sessionsKpi } from '../../src/lib/stats/kpi';
import { qualifying } from '../../src/lib/stats/core';
import { trend } from '../../src/lib/stats/dashboard';
import { doc, syntheticPaper } from '../fixtures/make';
import type { SessionSummary } from '../../src/lib/types';
import { Blob as NodeBlob } from 'node:buffer';

// happy-dom's Blob loses its methods through fake-indexeddb's structured clone; Node's does not.
(globalThis as { Blob: unknown }).Blob = NodeBlob;

let dbn = 0;
beforeEach(() => store.useDbName(`audit2-${++dbn}`));

async function importPack(d: unknown, packId: string | null = null, now?: number) {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  expect(r.result.errors).toEqual([]);
  const target = { packId, newPack: { title: 'Synthetic Physics', subject: 'Physics' } };
  const { merge, images } = await planImport(r.result.doc, target, null, {});
  expect(merge.conflicts).toEqual([]);
  return commitImport(target, merge, images, now);
}
async function plan(d: unknown, packId: string) {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  return planImport(r.result.doc, { packId }, null, {});
}
async function restoreBlob(blob: Blob) {
  const src = await readZip(blob, 'b.zip');
  await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images));
}
async function forgeProgress(mutate: (data: Record<string, unknown[]>) => void) {
  const { blob } = await createBackup('progress');
  const p = readProgressJson(await blob.text())!;
  const data = JSON.parse(p.data);
  mutate(data);
  const text = JSON.stringify(data);
  return { manifest: JSON.stringify({ ...JSON.parse(p.manifest), checksum: await sha256Hex(text) }), data: text };
}
async function forgeEverything(mutate: (data: Record<string, unknown[]>) => void) {
  const { blob } = await createBackup('everything');
  const src = await readZip(blob, 'b.zip');
  const data = JSON.parse(src.backup!.data);
  mutate(data);
  const text = JSON.stringify(data);
  return { manifest: JSON.stringify({ ...JSON.parse(src.backup!.manifest), checksum: await sha256Hex(text) }), data: text, images: src.backup!.images };
}

// ---------------------------------------------------------------------------------------------
describe('one open session per pack (decision 58)', () => {
  it('regression (was a bug): the check in createSession is outside the write transaction, so two concurrent starts both succeed', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)));
    const pack = (await store.getPack(id))!;
    const results = await Promise.allSettled([
      createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' }),
      createSession({ pack, type: 'random', mode: 'exam' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('session lock released after the final write (decision 57)', () => {
  it('regression (was a bug): Preact runs the parent SessionScreen cleanup before the child Runner cleanup, so the lock is released before the unmount save is even queued', async () => {
    // Mirrors session.tsx: SessionScreen's effect cleanup defers `finalWrite.then(release)` by a task; the
    // Runner child's unmount cleanup calls persist('saved', true), which calls setFinalWrite(...).
    setFinalWrite(Promise.resolve());
    let releasedAt = 0;
    let writeDoneAt = 0;
    let clock = 0;
    let finishWrite: () => void = () => {};
    function Runner() {
      useEffect(
        () => () => {
          setFinalWrite(new Promise<void>((r) => (finishWrite = () => { writeDoneAt = ++clock; r(); })));
        },
        [],
      );
      return null;
    }
    function SessionScreen() {
      useEffect(
        () => () => {
          // session.tsx: wait a task so the child's final save is queued, then release after it.
          setTimeout(() => void finalWrite.then(() => (releasedAt = ++clock)), 0);
        },
        [],
      );
      return h(Runner, null);
    }
    const root = document.createElement('div');
    act(() => render(h(SessionScreen, null), root));
    act(() => render(null, root)); // navigate away
    await new Promise((r) => setTimeout(r, 5));
    finishWrite();
    await new Promise((r) => setTimeout(r, 5));
    expect(releasedAt).toBeGreaterThan(writeDoneAt); // the lock must outlive the final write
  });
});

// ---------------------------------------------------------------------------------------------
describe('restore: pack paper union (decision 60)', () => {
  it('regression (was a bug): a newer pack row from a backup overwrites a more complete local paper and loses questions', async () => {
    // Device A and B share the pack (B restored A's first backup). B imports chunk 2 of p1;
    // A later fixes a question (fix.tsx refreshPackMeta bumps pack.updatedAt) and backs up.
    const id = await importPack(doc(syntheticPaper('p1', 4, { from: 1, to: 2 })), null, 1);
    const { blob: e1 } = await createBackup('everything');
    await store.putPack({ ...(await store.getPack(id))!, updatedAt: 3 }); // A's later fix
    const { blob: e2 } = await createBackup('everything');
    // Device B: starts from A's first backup, then imports the second chunk.
    await store.wipeAll();
    await restoreBlob(e1);
    const more = await plan(doc(syntheticPaper('p1', 4, { from: 3, to: 4 })), id);
    expect(more.merge.conflicts).toEqual([]);
    await commitImport({ packId: id }, more.merge, [], 2);
    expect((await store.getPaper(`${id}::p1`))!.questions).toHaveLength(4);
    // B restores A's newer backup: "merges and never deletes" (decision 54).
    await restoreBlob(e2);
    expect((await store.getPaper(`${id}::p1`))!.questions).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------------------------
describe('restore: row validation is shallow (decision 60)', () => {
  async function seed() {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const s = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await submitSession(s.summary.id, true);
    return id;
  }

  it('regression (was a bug): a paper whose questions array holds null passes validation, then loading the pack throws', async () => {
    const id = await seed();
    const forged = await forgeEverything((d) => {
      const p = d.papers![0] as { questions: unknown[]; addedAt: number };
      p.questions = [null, ...p.questions.slice(1)];
      (d.packs![0] as { updatedAt: number }).updatedAt = Date.now() + 10_000; // make it win
    });
    let rejected = false;
    try {
      await applyRestore(await planRestore(forged.manifest, forged.data, forged.images));
    } catch {
      rejected = true;
    }
    if (!rejected) await expect(loadPackContent(id)).resolves.toBeTruthy(); // throws TypeError today
  });

  it('regression (was a bug): settings of the wrong types are accepted (backupEvery "never", theme 42)', async () => {
    await seed();
    const forged = await forgeProgress((d) => {
      d.meta = [{ key: 'settings', value: { backupEvery: 'never', theme: 42, dismissedTips: 'x' } }];
    });
    await store.wipeAll(); // no local settings, so the incoming row is applied
    let rejected = false;
    try {
      await applyRestore(await planRestore(forged.manifest, forged.data, new Map()));
    } catch {
      rejected = true;
    }
    const s = await store.getSettings();
    expect(rejected || (typeof s.backupEvery === 'number' && Array.isArray(s.dismissedTips))).toBe(true);
  });

  it('regression (was a bug): a question stat whose key disagrees with packId/qid is accepted and duplicates a stat', async () => {
    const id = await seed();
    const forged = await forgeProgress((d) => {
      d.questionStats = [{ key: 'junk', packId: id, qid: 'p1#1', timesSeen: 99, attempts: 99, inBank: true, missed: 0, streak: 0, timeSum: 0 }];
    });
    let rejected = false;
    try {
      await applyRestore(await planRestore(forged.manifest, forged.data, new Map()));
    } catch {
      rejected = true;
    }
    expect(rejected || (await store.getStats(id)).every((s) => s.key === `${s.packId}::${s.qid}`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('imports (decisions 61, 62)', () => {
  it('regression (was a bug): two plans for chunks of the same paper, committed one after the other, drop the first chunk', async () => {
    // Two import wizards (two tabs) planned against the same stored paper.
    const id = await importPack(doc(syntheticPaper('p0', 4)));
    const a = await plan(doc(syntheticPaper('p1', 4, { from: 1, to: 2 })), id);
    const b = await plan(doc(syntheticPaper('p1', 4, { from: 3, to: 4 })), id);
    await commitImport({ packId: id }, a.merge, []);
    await commitImport({ packId: id }, b.merge, []);
    expect((await store.getPaper(`${id}::p1`))!.questions).toHaveLength(4);
  });

  it('regression (was a bug): the pack-id collision check tests the bare slug, which is never used as an id, so a suffix collision overwrites an existing pack', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T) => a);
    try {
      const first = await importPack(doc(syntheticPaper('p1', 4)));
      const second = await importPack(doc(syntheticPaper('p2', 4)));
      expect(second).not.toBe(first);
      expect((await store.getPack(first))!.papers.map((p) => p.id)).toEqual(['p1']);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------------------------
describe('zero-answer auto-submit (decision 34 exception)', () => {
  it('is partial, never done, never counted, never in the trend', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const s = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', timer: { kind: 'total', minutes: 1 } });
    const r = (await submitSession(s.summary.id, true))!;
    expect(r.summary.partial).toBe(true);
    const all = await store.getSessions(id);
    expect(papersDone(all).size).toBe(0);
    expect(sessionsKpi(all, pack.papers, Date.now()).value).toBe(0);
    expect(qualifying(all, { includePartial: true })).toHaveLength(0);
  });

  it('submitSession caps recorded time at the session budget (decision 79)', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const s = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', timer: { kind: 'total', minutes: 1 } });
    const d = (await store.getDetail(s.summary.id))!;
    d.answers.forEach((a) => {
      a.choice = 0;
      a.timeMs = 3_600_000;
    });
    await store.persistOpenSession(s.summary, d);
    const r = (await submitSession(s.summary.id, false))!;
    expect(r.summary.timeMs).toBe(60_000);
  });
});

// ---------------------------------------------------------------------------------------------
describe('timer and noise models', () => {
  it('regression (was a bug): sanitizeTimer floors a bad per-question budget at 1 ms, not at one whole second', () => {
    const c = sanitizeTimer({ kind: 'perq', capMs: 600_000, totalMs: 600_000, perQMs: -5000 }, 10);
    expect(c.perQMs!).toBeGreaterThanOrEqual(1000);
  });

  it('regression (was a bug): the trend band collapses to zero width for a perfectly steady series (no half-question floor as in the verdict)', () => {
    const mk = (i: number): SessionSummary => ({
      id: `s${i}`, packId: 'p', type: 'paper', mode: 'exam', title: 't', status: 'submitted', partial: false,
      startedAt: i, endedAt: i, updatedAt: i, total: 40, answered: 40, correct: 20 + 2 * i, timeMs: 1,
    });
    const t = trend([0, 1, 2, 3, 4, 5].map(mk), 'score');
    expect(t.sdOne).toBeGreaterThanOrEqual(0.5 / 40);
  });
});
