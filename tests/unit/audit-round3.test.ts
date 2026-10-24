// Audit (logic round 3): the round-2 fixes and the new code paths.
// Tests titled "regression (was a bug)" describe bugs the audits found; they now guard the fixes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as store from '../../src/lib/data/db';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { applyRestore, createBackup, exportPackZip, planRestore, readProgressJson } from '../../src/lib/data/backup';
import { readZip, sha256Hex } from '../../src/lib/data/files';
import { createSession, packStandardLength, submitSession } from '../../src/lib/engine/session';
import { doc, syntheticPaper } from '../fixtures/make';
import { Blob as NodeBlob } from 'node:buffer';

// happy-dom's Blob loses its methods through fake-indexeddb's structured clone; Node's does not.
(globalThis as { Blob: unknown }).Blob = NodeBlob;

let dbn = 0;
beforeEach(() => store.useDbName(`audit3-${++dbn}`));

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
  const p = await planImport(r.result.doc, { packId }, null, {});
  expect(p.merge.conflicts).toEqual([]);
  return p;
}
async function restoreBlob(blob: Blob) {
  const src = await readZip(blob, 'b.zip');
  await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images));
}
type Data = Record<string, Record<string, unknown>[]>;
async function forgeEverything(mutate: (d: Data) => void) {
  const { blob } = await createBackup('everything');
  const src = await readZip(blob, 'b.zip');
  const data = JSON.parse(src.backup!.data);
  mutate(data);
  const text = JSON.stringify(data);
  return { manifest: JSON.stringify({ ...JSON.parse(src.backup!.manifest), checksum: await sha256Hex(text) }), data: text, images: src.backup!.images };
}
async function forgeProgressText(mutateText: (dataText: string) => string) {
  const { blob } = await createBackup('progress');
  const p = readProgressJson(await blob.text())!;
  const text = mutateText(p.data);
  return { manifest: JSON.stringify({ ...JSON.parse(p.manifest), checksum: await sha256Hex(text) }), data: text };
}
async function tryRestore(f: { manifest: string; data: string; images?: Map<string, Blob> }) {
  try {
    await applyRestore(await planRestore(f.manifest, f.data, f.images ?? new Map()));
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------------
describe('round-2 regressions hold', () => {
  it('R1: concurrent starts in one pack: exactly one succeeds', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)));
    const pack = (await store.getPack(id))!;
    const rs = await Promise.allSettled([
      createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' }),
      createSession({ pack, type: 'random', mode: 'exam' }),
      createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p2' }),
    ]);
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.getOpenSessions()).filter((s) => s.packId === id)).toHaveLength(1);
  });

  it('R5b: forced suffix collisions fall back to a counter and never overwrite', async () => {
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T) => a);
    try {
      const ids = [await importPack(doc(syntheticPaper('p1', 4))), await importPack(doc(syntheticPaper('p2', 4))), await importPack(doc(syntheticPaper('p3', 4)))];
      expect(new Set(ids).size).toBe(3);
      for (const [i, id] of ids.entries()) expect((await store.getPack(id))!.papers.map((p) => p.id)).toEqual([`p${i + 1}`]);
    } finally {
      spy.mockRestore();
    }
  });

  it('R3: a newer backup copy keeps local-only questions and recomputes the pack meta', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4, { from: 1, to: 2 })), null, 1);
    const { blob: e1 } = await createBackup('everything');
    await store.putPack({ ...(await store.getPack(id))!, updatedAt: 3 });
    const { blob: e2 } = await createBackup('everything');
    await store.wipeAll();
    await restoreBlob(e1);
    await commitImport({ packId: id }, (await plan(doc(syntheticPaper('p1', 4, { from: 3, to: 4 })), id)).merge, [], 2);
    await restoreBlob(e2);
    expect((await store.getPaper(`${id}::p1`))!.questions).toHaveLength(4);
    expect((await store.getPack(id))!.papers[0]).toMatchObject({ present: 4, keyed: 4 });
  });
});

// ---------------------------------------------------------------------------------------------
describe('restore paper merge (decision 86)', () => {
  it('regression (was a bug): an OLDER backup copy of a paper with questions the local copy lacks is not merged (only newer copies merge)', async () => {
    // Backup: p1 complete (4 questions), pack updatedAt 3.
    const id = await importPack(doc(syntheticPaper('p1', 4, { from: 1, to: 2 })), null, 1);
    const { blob: e0 } = await createBackup('everything'); // p1 with 2 questions
    await commitImport({ packId: id }, (await plan(doc(syntheticPaper('p1', 4, { from: 3, to: 4 })), id)).merge, [], 3);
    const { blob: full } = await createBackup('everything'); // p1 with 4 questions
    // This device: started from the 2-question backup, then fixed a question (pack.updatedAt 5).
    await store.wipeAll();
    await restoreBlob(e0);
    await store.putPack({ ...(await store.getPack(id))!, updatedAt: 5 });
    await restoreBlob(full);
    expect((await store.getPaper(`${id}::p1`))!.questions).toHaveLength(4); // stays 2
  });
});

// ---------------------------------------------------------------------------------------------
describe('commitImport question merge (decision 86)', () => {
  it('regression (was a bug): a stale plan that covers already-stored questions overwrites a key applied since it was planned', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4, { answers: false })));
    // Tab 1 plans an identical re-import of p1; tab 2 plans the answer key.
    const stale = await plan(doc(syntheticPaper('p1', 4, { answers: false })), id);
    const key = await plan({ answers: [{ paper: 'p1', key: 'BCDA' }] }, id);
    await commitImport({ packId: id }, key.merge, []);
    expect((await store.getPack(id))!.papers[0]!.keyed).toBe(4);
    await commitImport({ packId: id }, stale.merge, []);
    // The stale copy's unkeyed questions win for every n it carries.
    expect((await store.getPack(id))!.papers[0]!.keyed).toBe(4);
  });
});

// ---------------------------------------------------------------------------------------------
describe('restore validation (decision 87): remaining gaps', () => {
  async function seed() {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const s = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', timer: { kind: 'total', minutes: 5 } });
    return { id, sid: s.summary.id };
  }

  it('regression (was a bug): a non-numeric timer cap in a restored session becomes NaN, so the clock never reaches zero', async () => {
    const { sid } = await seed();
    const f = await forgeEverything((d) => {
      const det = d.sessionDetail!.find((x) => x.id === sid) as { timer: { config: Record<string, unknown> } };
      det.timer.config.capMs = 'lots';
    });
    await store.wipeAll();
    if (await tryRestore(f)) return;
    const det = (await store.getDetail(sid))!;
    expect(Number.isFinite(det.timer!.remainingMs)).toBe(true);
    expect(Number.isFinite(det.timer!.config.capMs)).toBe(true);
  });

  it('regression (was a bug): pack paper metas are not validated: a winning pack row with papers [null] breaks the pack', async () => {
    const { id } = await seed();
    const f = await forgeEverything((d) => {
      d.packs![0]!.papers = [null];
    });
    await store.wipeAll(); // restoring onto a fresh device (with a local copy it aborts with a raw TypeError)
    const rejected = await tryRestore(f);
    if (rejected) return;
    const pack = (await store.getPack(id))!;
    expect(() => packStandardLength(pack)).not.toThrow(); // TypeError: reading 'questionCount' of null
  });

  it('regression (was a bug): question content shape is not validated: options as a number pass, and exporting the pack throws', async () => {
    const { id } = await seed();
    const f = await forgeEverything((d) => {
      (d.papers![0]!.questions as Record<string, unknown>[])[0]!.options = 5;
      d.packs![0]!.updatedAt = Date.now() + 60_000;
    });
    const rejected = await tryRestore(f);
    if (rejected) return;
    const pack = (await store.getPack(id))!;
    await expect(exportPackZip(pack, await store.getPapers(id), [])).resolves.toBeTruthy();
  });

  it('regression (was a bug): settings numbers are type-checked but not range-checked: 1e400 restores as Infinity', async () => {
    await seed();
    await store.putSettings(await store.getSettings());
    const f = await forgeProgressText((t) => t.replace('"lastBackupAtCount":0', '"lastBackupAtCount":1e400'));
    expect(f.data).toContain('1e400');
    await store.wipeAll(); // no local settings, so the incoming row applies
    const rejected = await tryRestore(f);
    expect(rejected || Number.isFinite((await store.getSettings()).lastBackupAtCount)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('submit after a refused save', () => {
  it('submitting a discarded session returns null (the screen then navigates to "Results not found")', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const s = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await store.deleteSession(s.summary.id);
    expect(await store.persistOpenSession(s.summary, s.detail)).toBe(false);
    expect(await submitSession(s.summary.id, false)).toBeNull();
  });
});
