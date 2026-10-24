// Audit (logic round 1): session lifecycle (randomised), data layer races, imports and backups.
// Tests marked it.fails demonstrate real bugs; they pass while the bug exists.
import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/lib/data/db';
import { commitImport, parseImport, planImport } from '../../src/lib/data/importer';
import { applyRestore, createBackup, planRestore, readProgressJson } from '../../src/lib/data/backup';
import { readZip, sha256Hex } from '../../src/lib/data/files';
import { createSession, loadSessionQuestions, submitSession } from '../../src/lib/engine/session';
import { gradeSession } from '../../src/lib/engine/grade';
import { CLEAR_STREAK, statKey } from '../../src/lib/engine/mistakes';
import { mulberry32, type Rng } from '../../src/lib/engine/rng';
import { doc, syntheticPaper } from '../fixtures/make';
import type { Pack, QuestionStat, SessionDetail, SessionSummary } from '../../src/lib/types';
import { Blob as NodeBlob } from 'node:buffer';

// happy-dom's Blob does not survive fake-indexeddb's structured clone (methods are lost), which
// would make image round-trips untestable. Node's Blob clones correctly, as browsers' do.
(globalThis as { Blob: unknown }).Blob = NodeBlob;

let dbn = 0;
beforeEach(() => store.useDbName(`audit-${++dbn}`));

async function importPack(d: unknown, packId: string | null = null, title = 'Synthetic Physics') {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  expect(r.result.errors).toEqual([]);
  const target = { packId, newPack: { title, subject: 'Physics' } };
  const { merge, images } = await planImport(r.result.doc, target, null, {});
  expect(merge.conflicts).toEqual([]);
  return commitImport(target, merge, images);
}
async function plan(d: unknown, packId: string | null) {
  const r = parseImport(JSON.stringify(d));
  if (!r.ok) throw new Error(r.syntax);
  return planImport(r.result.doc, { packId, newPack: { title: 'X', subject: '' } }, null, {});
}
const keyOf = (qid: string) => Number(qid.split('#')[1]) % 4; // synthetic key: n % 4
async function answer(id: string, pick: (i: number, qid: string) => { choice: number | null; unsure?: boolean } | null) {
  const d = (await store.getDetail(id))!;
  const s = (await store.getSession(id))!;
  d.answers.forEach((a, i) => {
    const p = pick(i, a.qid);
    if (!p) return;
    a.choice = p.choice;
    a.first = p.choice;
    a.unsure = !!p.unsure;
    a.timeMs += 20_000;
  });
  await store.saveSessionState({ ...s, answered: d.answers.filter((a) => a.choice !== null).length }, d);
  return { s, d };
}
async function snapshot() {
  const d = await store.db();
  const out: Record<string, unknown> = {};
  for (const s of store.STORES) {
    if (s === 'meta') out[s] = await d.get('meta', 'settings');
    else if (s === 'images') out[s] = await Promise.all((await d.getAll('images')).map(async (i) => [i.id, i.type, await sha256Hex(await i.blob.arrayBuffer())]));
    else out[s] = await d.getAll(s as never);
  }
  return JSON.parse(JSON.stringify(out));
}

// ---------------------------------------------------------------------------------------------
describe('session lifecycle: randomised sequences of create / answer / save / submit / discard', () => {
  const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

  async function runSequence(seed: number) {
    const rng = mulberry32(seed);
    store.useDbName(`audit-seq-${seed}-${++dbn}`);
    const packId = await importPack(doc(syntheticPaper('p1', 5), syntheticPaper('p2', 5), syntheticPaper('p3', 5)));
    const pack = (await store.getPack(packId)) as Pack;
    let now = 1_800_000_000_000;
    for (let step = 0; step < 40; step++) {
      now += int(rng, 1, 10) * 60_000;
      const open = (await store.getOpenSessions()).filter((s) => s.packId === packId);
      const roll = rng();
      if (roll < 0.35 || !open.length) {
        // Create. Paper sessions only when nothing is open (UI rule); random/drill may overlap a saved session.
        const type = (['paper', 'random', 'drill'] as const)[int(rng, 0, 2)]!;
        if (type === 'paper' && open.length) continue;
        const statsBefore = new Map((await store.getStats(packId)).map((s) => [s.qid, s] as const));
        const lockedBefore = new Set<string>();
        for (const o of open) (await store.getDetail(o.id))!.questionIds.forEach((q) => lockedBefore.add(q));
        let created: { summary: SessionSummary; detail: SessionDetail };
        try {
          created = await createSession({ pack, type, mode: rng() < 0.7 ? 'exam' : 'practice', paperId: `p${int(rng, 1, 3)}`, smart: rng() < 0.5 }, now);
        } catch (e) {
          expect((e as Error).message).toMatch(/No questions available/);
          continue;
        }
        const ids = created.detail.questionIds;
        expect(new Set(ids).size).toBe(ids.length);
        for (const q of ids) expect(lockedBefore.has(q)).toBe(false);
        if (type === 'random') {
          const allQ = ['p1', 'p2', 'p3'].flatMap((p) => [1, 2, 3, 4, 5].map((n) => `${p}#${n}`)).filter((q) => !lockedBefore.has(q));
          const seen = (q: string) => statsBefore.get(q)?.timesSeen ?? 0;
          const maxTier = Math.max(...ids.map(seen));
          for (const q of allQ) if (seen(q) < maxTier) expect(ids).toContain(q);
          expect(ids.length).toBe(Math.min(5, allQ.length));
        }
        if (type === 'drill') for (const q of ids) expect(statsBefore.get(q)?.inBank).toBe(true);
        continue;
      }
      const target = open[int(rng, 0, open.length - 1)]!;
      if (roll < 0.65) {
        await answer(target.id, () => (rng() < 0.5 ? { choice: rng() < 0.15 ? null : int(rng, 0, 3), unsure: rng() < 0.2 } : null));
      } else if (roll < 0.75) {
        const s = (await store.getSession(target.id))!;
        await store.saveSessionState({ ...s, status: 'saved' }, (await store.getDetail(target.id))!);
      } else if (roll < 0.95) {
        const auto = rng() < 0.3;
        const answered = (await store.getDetail(target.id))!.answers.some((a) => a.choice !== null);
        if (!auto && !answered) continue; // the Submit button is disabled with nothing answered
        const r = (await submitSession(target.id, auto, now))!;
        const d = (await store.getDetail(target.id))!;
        const g = gradeSession(d.answers, keyOf, auto);
        expect(r.summary.answered).toBe(g.answered);
        expect(r.summary.correct).toBe(g.correct);
        expect(r.summary.partial).toBe(!auto && g.answered < d.answers.length);
        // Re-submitting is a no-op.
        await submitSession(target.id, !auto, now + 1);
      } else {
        await store.deleteSession(target.id);
      }
      await checkStats(packId);
    }
  }

  /** Recomputes every question stat from the submitted sessions, by the spec, and compares. */
  async function checkStats(packId: string) {
    const finished = (await store.getSessions(packId))
      .filter((s) => s.status === 'submitted' || s.status === 'auto-submitted')
      .sort((a, b) => a.endedAt! - b.endedAt!);
    const ref = new Map<string, { seen: number; attempts: number; missed: number; inBank: boolean; goods: number }>();
    for (const s of finished) {
      const d = (await store.getDetail(s.id))!;
      for (const a of d.answers) {
        if (a.choice === null) continue;
        const r = ref.get(a.qid) ?? { seen: 0, attempts: 0, missed: 0, inBank: false, goods: 0 };
        const correct = a.choice === keyOf(a.qid);
        r.attempts++;
        if (s.type !== 'drill') r.seen++;
        if (!correct) r.missed++;
        if (!correct || a.unsure) {
          r.inBank = true;
          r.goods = 0;
        } else if (++r.goods >= CLEAR_STREAK) r.inBank = false;
        ref.set(a.qid, r);
      }
    }
    const stats = new Map((await store.getStats(packId)).map((s) => [s.qid, s] as const));
    expect(stats.size).toBe(ref.size);
    for (const [qid, r] of ref) {
      const s = stats.get(qid) as QuestionStat;
      expect({ qid, seen: s.timesSeen, attempts: s.attempts, missed: s.missed, inBank: s.inBank }).toEqual({ qid, seen: r.seen, attempts: r.attempts, missed: r.missed, inBank: r.inBank });
    }
  }

  it('stats, bank, seen counts, locking and tier order hold across 25 random sequences', async () => {
    for (let seed = 1; seed <= 25; seed++) await runSequence(seed);
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------
describe('session lifecycle: races and invariants', () => {
  async function setup() {
    const packId = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)));
    return { packId, pack: (await store.getPack(packId))! };
  }

  it('concurrent submits of the same session grade it once', async () => {
    const { packId, pack } = await setup();
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await answer(summary.id, (_i, q) => ({ choice: keyOf(q) }));
    await Promise.all([submitSession(summary.id, false), submitSession(summary.id, true), submitSession(summary.id, false)]);
    const stats = await store.getStats(packId);
    expect(stats.map((s) => s.attempts)).toEqual([1, 1, 1, 1]);
  });

  it.fails('BUG: a stale autosave after submit (second tab, or pack-page submit while the session screen is open) un-submits the session and the next submit grades it twice', async () => {
    const { packId, pack } = await setup();
    const { summary, detail } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    const { d } = await answer(summary.id, (_i, q) => ({ choice: keyOf(q) }));
    // Tab B (pack page "Submit" on the saved/active session) submits.
    await submitSession(summary.id, false, 1000);
    // Tab A's Runner still holds the session and autosaves (session.tsx write(): saveSessionState
    // with its initial summary and status 'active'). Nothing in the store refuses the write.
    await store.saveSessionState({ ...summary, status: 'active', answered: 4 }, { ...detail, answers: d.answers });
    // Tab A then submits (or the session is recovered and submitted later).
    await submitSession(summary.id, false, 2000);
    const stats = await store.getStats(packId);
    expect(stats.map((s) => s.attempts)).toEqual([1, 1, 1, 1]); // actually 2 each
    expect(stats.map((s) => s.timesSeen)).toEqual([1, 1, 1, 1]);
  });

  it.fails('BUG: a stale autosave after "Delete pack" or "Discard" resurrects an orphan open session', async () => {
    const { packId, pack } = await setup();
    const { summary, detail } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await store.deletePack(packId);
    await store.saveSessionState({ ...summary, status: 'active' }, detail); // the open Runner's next tick
    expect(await store.getOpenSessions()).toEqual([]);
  });

  it.fails('BUG: the engine allows a second open session in a pack that has a saved session (one saved session per pack)', async () => {
    const { pack } = await setup();
    const a = await createSession({ pack, type: 'random', mode: 'exam' });
    const s = (await store.getSession(a.summary.id))!;
    await store.saveSessionState({ ...s, status: 'saved' }, a.detail);
    await expect(createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' })).rejects.toThrow();
  });

  it.fails('BUG: paper sessions ignore questions locked by another open session', async () => {
    const { pack } = await setup();
    const a = await createSession({ pack, type: 'random', mode: 'exam' }); // locks 4 of the 8
    const s = (await store.getSession(a.summary.id))!;
    await store.saveSessionState({ ...s, status: 'saved' }, a.detail);
    const lockedP1 = a.detail.questionIds.filter((q) => q.startsWith('p1#'));
    const lockedP2 = a.detail.questionIds.filter((q) => q.startsWith('p2#'));
    const paperId = lockedP1.length >= lockedP2.length ? 'p1' : 'p2';
    const b = await createSession({ pack, type: 'paper', mode: 'exam', paperId });
    expect(b.detail.questionIds.some((q) => a.detail.questionIds.includes(q))).toBe(false);
  });

  it('auto-submit with nothing answered: complete, nothing graded, nothing seen', async () => {
    const { packId, pack } = await setup();
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1', timer: { kind: 'total', minutes: 1 } });
    const r = (await submitSession(summary.id, true))!;
    expect(r.summary).toMatchObject({ status: 'auto-submitted', partial: false, answered: 0, correct: 0 });
    expect(await store.getStats(packId)).toEqual([]);
    const det = (await store.getDetail(summary.id))!;
    expect(det.timer!.endAt).toBeUndefined();
  });

  it.fails('BUG: fixing the answer key after a session leaves the stored score, the bank and the results review disagreeing', async () => {
    const { packId, pack } = await setup();
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    // Answer everything 'A' (index 0); the key says p1#4 is A, the others are not.
    await answer(summary.id, () => ({ choice: 0 }));
    const r = (await submitSession(summary.id, false))!;
    expect(r.summary.correct).toBe(1);
    // The user fixes question 1's key to A (Fix this question -> override).
    await store.putOverride({ key: statKey(packId, 'p1#1'), packId, qid: 'p1#1', answer: 0, updatedAt: Date.now() });
    // The results page regrades with the current key (results.tsx gradeSession(...)) ...
    const det = (await store.getDetail(summary.id))!;
    const q = await loadSessionQuestions(det);
    const regraded = gradeSession(det.answers, (id) => q.get(id)?.answer, false);
    // ... so it shows 2 correct in the review list and the rushed analysis, while the ring,
    // trend, KPIs and the mistakes bank still use the stored 1 correct.
    expect(regraded.correct).toBe((await store.getSession(summary.id))!.correct);
    expect((await store.getStats(packId)).find((s) => s.qid === 'p1#1')!.inBank).toBe(false);
  });

  it('deleting a pack with a saved session removes the session, its detail, stats, events and overrides', async () => {
    const { packId, pack } = await setup();
    const a = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' });
    await answer(a.summary.id, () => ({ choice: 0 }));
    await submitSession(a.summary.id, false);
    const b = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p2' });
    await store.saveSessionState({ ...b.summary, status: 'saved' }, b.detail);
    await store.putOverride({ key: statKey(packId, 'p1#1'), packId, qid: 'p1#1', answer: 0, updatedAt: 1 });
    await store.deletePack(packId);
    const snap = await snapshot();
    for (const s of ['packs', 'papers', 'sessions', 'sessionDetail', 'questionStats', 'bankEvents', 'overrides']) expect(snap[s]).toEqual([]);
  });

  it('stats are keyed by pack: identical paper ids in two packs never interfere', async () => {
    const a = await importPack(doc(syntheticPaper('p1', 4)), null, 'Pack A');
    const b = await importPack(doc(syntheticPaper('p1', 4)), null, 'Pack B');
    expect(a).not.toBe(b);
    const packA = (await store.getPack(a))!;
    const s = await createSession({ pack: packA, type: 'paper', mode: 'exam', paperId: 'p1' });
    await answer(s.summary.id, () => ({ choice: 0 }));
    await submitSession(s.summary.id, false);
    await store.saveSessionState({ ...(await createSession({ pack: packA, type: 'random', mode: 'exam' })).summary, status: 'saved' }, (await store.getDetail((await store.getOpenSessions())[0]!.id))!);
    expect(await store.getStats(b)).toEqual([]);
    const rb = await createSession({ pack: (await store.getPack(b))!, type: 'random', mode: 'exam' });
    expect(rb.detail.questionIds).toHaveLength(4); // pack A's saved session locks nothing in pack B
  });
});

// ---------------------------------------------------------------------------------------------
describe('imports', () => {
  it('re-importing identical content adds nothing; answers-only key applies later; a changed question is a conflict', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4, { answers: false })));
    const again = await plan(doc(syntheticPaper('p1', 4, { answers: false })), id);
    expect(again.merge.plan[0]!.status).toBe('identical');
    await importPack({ answers: [{ paper: 'p1', key: 'BCDA' }] }, id);
    const p = (await store.getPaper(`${id}::p1`))!;
    expect(p.questions.map((q) => q.answer)).toEqual([1, 2, 3, 0]);
    const changed = syntheticPaper('p1', 4);
    (changed.questions[0] as { stem: string }).stem = 'Different';
    expect((await plan(doc(changed), id)).merge.conflicts).toHaveLength(1);
    expect((await store.getPaper(`${id}::p1`))!.questions).toHaveLength(4);
  });

  it('a key that arrives before the remaining chunk keys that chunk on arrival', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4, { answers: false, from: 1, to: 2 })));
    await importPack({ answers: [{ paper: 'p1', key: 'BCDA' }] }, id);
    await importPack(doc(syntheticPaper('p1', 4, { answers: false, from: 3, to: 4 })), id);
    const meta = (await store.getPack(id))!.papers[0]!;
    expect(meta).toMatchObject({ present: 4, keyed: 4 });
  });

  it.fails('BUG: a later chunk that declares a larger questionCount silently grows the paper past its count', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const more = await plan(doc(syntheticPaper('p1', 6, { from: 5, to: 6 })), id);
    // Expected: a conflict (the paper already has 4 questions), or questionCount updated to 6.
    const p = more.merge.papers[0]!;
    expect(more.merge.conflicts.length > 0 || p.questionCount === p.questions.length).toBe(true);
  });

  it.fails('BUG: two imports committed concurrently into one pack lose a paper from the pack metadata', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const a = await plan(doc(syntheticPaper('p2', 4)), id);
    const b = await plan(doc(syntheticPaper('p3', 4)), id);
    await Promise.all([commitImport({ packId: id }, a.merge, []), commitImport({ packId: id }, b.merge, [])]);
    const metas = (await store.getPack(id))!.papers.map((p) => p.id).sort();
    expect(metas).toEqual(['p1', 'p2', 'p3']); // papers store has all three
  });

  it('prototype-polluting keys in an import do not pollute Object.prototype', async () => {
    const text = '{"format":"dmc-pack/1","__proto__":{"polluted":1},"papers":[{"id":"constructor","title":"T","questionCount":1,"timeLimitMinutes":5,"optionCount":4,"constructor":{"x":1},"questions":[{"n":1,"stem":"s","options":["a","b","c","d"],"answer":"A","__proto__":{"polluted":2}}]}]}';
    const r = parseImport(text);
    expect(r.ok).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    if (r.ok) {
      const { merge } = await planImport(r.result.doc, { packId: null, newPack: { title: 'P', subject: '' } }, null, {});
      expect(merge.conflicts).toEqual([]);
      expect(merge.papers[0]!.title).toBe('T');
    }
  });

  it('huge input: 200 papers x 100 questions parses and plans in reasonable time', async () => {
    const papers = Array.from({ length: 200 }, (_, i) => syntheticPaper(`p${i}`, 100));
    const t0 = Date.now();
    const r = parseImport(JSON.stringify(doc(...papers)));
    expect(r.ok && r.result.errors).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
describe('backups', () => {
  async function richState() {
    const id = await importPack(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4)));
    const pack = (await store.getPack(id))!;
    const img = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    const imgId = await sha256Hex(await img.arrayBuffer());
    await (await store.db()).put('images', { id: imgId, type: 'image/png', blob: img });
    await store.putOverride({ key: statKey(id, 'p1#1'), packId: id, qid: 'p1#1', figure: { kind: 'image', imageId: imgId }, updatedAt: 5 });
    const a = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' }, 1000);
    await answer(a.summary.id, () => ({ choice: 0, unsure: true }));
    await submitSession(a.summary.id, false, 2000);
    const dr = await createSession({ pack, type: 'drill', mode: 'exam' }, 3000);
    await answer(dr.summary.id, (_i, q) => ({ choice: keyOf(q) }));
    await submitSession(dr.summary.id, true, 4000);
    const b = await createSession({ pack, type: 'random', mode: 'exam', timer: { kind: 'total', minutes: 3 } }, 5000);
    await store.saveSessionState({ ...b.summary, status: 'saved' }, { ...b.detail, timer: { ...b.detail.timer!, remainingMs: 77_000 } });
    await store.putSettings({ ...(await store.getSettings()), smartRandom: true, examDate: '2027-01-01' });
    return { id, imgId };
  }

  it('everything: export -> wipe -> import reproduces identical state (images, events, saved session, overrides)', async () => {
    await richState();
    const before = await snapshot();
    const { blob } = await createBackup('everything');
    await store.wipeAll();
    const src = await readZip(blob, 'b.zip');
    await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images));
    expect(await snapshot()).toEqual(before);
    // Restoring the same backup again over the restored state changes nothing.
    await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images));
    expect(await snapshot()).toEqual(before);
  });

  it('a tampered backup with a recomputed checksum and an invalid row is rejected atomically', async () => {
    await richState();
    const before = await snapshot();
    const { blob } = await createBackup('progress');
    const p = readProgressJson(await blob.text())!;
    const data = JSON.parse(p.data);
    data.sessions.push({ title: 'no id' });
    const tampered = JSON.stringify(data);
    const manifest = JSON.stringify({ ...JSON.parse(p.manifest), checksum: await sha256Hex(tampered) });
    const planned = await planRestore(manifest, tampered, new Map());
    await expect(applyRestore(planned)).rejects.toBeTruthy();
    expect(await snapshot()).toEqual(before);
  });

  it.fails('BUG: restore applies semantically invalid rows (recomputed checksum): no schema validation', async () => {
    const { id } = await richState();
    const { blob } = await createBackup('progress');
    const p = readProgressJson(await blob.text())!;
    const data = JSON.parse(p.data);
    // A second saved session in the same pack, with 10 hours left on a 3-minute cap.
    const s = data.sessions.find((x: SessionSummary) => x.status === 'saved');
    const d = data.sessionDetail.find((x: SessionDetail) => x.id === s.id);
    data.sessions.push({ ...s, id: 's_forged', updatedAt: Date.now() });
    data.sessionDetail.push({ ...d, id: 's_forged', timer: { ...d.timer, remainingMs: 36_000_000 } });
    data.meta[0].value.backupEvery = 'never';
    const tampered = JSON.stringify(data);
    const manifest = JSON.stringify({ ...JSON.parse(p.manifest), checksum: await sha256Hex(tampered) });
    await applyRestore(await planRestore(manifest, tampered, new Map()));
    const open = (await store.getOpenSessions()).filter((x) => x.packId === id);
    expect(open).toHaveLength(1);
  });

  it.fails('BUG: image bytes in a backup zip are not verified against their sha-256 id', async () => {
    const { imgId } = await richState();
    const { blob } = await createBackup('everything');
    const { unzipSync, zipSync } = await import('fflate');
    const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    files[`images/${imgId}`] = new Uint8Array([9, 9, 9]);
    const evil = new Blob([zipSync(files) as BlobPart]);
    await store.wipeAll();
    const src = await readZip(evil, 'b.zip');
    let rejected = false;
    try {
      await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images));
    } catch {
      rejected = true;
    }
    const img = await store.getImage(imgId);
    const ok = !img || (await sha256Hex(await img.blob.arrayBuffer())) === imgId;
    expect(rejected || ok).toBe(true);
  });

  it.fails('BUG: restoring a newer copy of a same-id pack replaces its paper list but leaves the other papers in the store, invisible yet still drawn by Random', async () => {
    // Device 2 imported "Synthetic Physics" (slug id) with p1 only, later than device 1.
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const { blob } = await createBackup('everything');
    await store.wipeAll();
    // Device 1: same title -> same pack id, papers p1 and p2, imported earlier.
    const r = parseImport(JSON.stringify(doc(syntheticPaper('p1', 4), syntheticPaper('p2', 4))));
    if (!r.ok) throw new Error('parse');
    const t = { packId: null, newPack: { title: 'Synthetic Physics', subject: 'Physics' } };
    const pl = await planImport(r.result.doc, t, null, {});
    expect(await commitImport(t, pl.merge, [], 1)).toBe(id);
    const src = await readZip(blob, 'b.zip');
    await applyRestore(await planRestore(src.backup!.manifest, src.backup!.data, src.backup!.images));
    const listed = (await store.getPack(id))!.papers.map((p) => p.id).sort();
    const stored = (await store.getPapers(id)).map((p) => p.id).sort();
    expect(listed).toEqual(stored); // listed [p1], stored [p1, p2]
  });

  it('prototype-polluting keys in a backup do not pollute Object.prototype', async () => {
    const data = '{"__proto__":{"polluted":1},"meta":[{"key":"settings","value":{"__proto__":{"polluted":2},"theme":"dark"}}]}';
    const manifest = JSON.stringify({ format: 'dmc-backup/1', tier: 'progress', createdAt: 0, app: 't', checksum: await sha256Hex(data), counts: {}, images: {} });
    await applyRestore(await planRestore(manifest, data, new Map()));
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await store.getSettings()).theme).toBe('dark');
  });
});
