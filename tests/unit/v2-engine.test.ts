import { beforeEach, describe, expect, it } from 'vitest';
import * as store from '../../src/lib/data/db';
import { createSession, submitSession } from '../../src/lib/engine/session';
import { applyAnswer, emptyStat } from '../../src/lib/engine/mistakes';
import { rebuildStats, replayStats } from '../../src/lib/engine/regrade';
import { setPaperKey } from '../../src/lib/data/keys';
import { gradeFor } from '../../src/lib/format/merge';
import { parseBoundaries, validateDoc } from '../../src/lib/format/validate';
import { parseMarkScheme } from '../../src/lib/format/markscheme';
import { timerColour } from '../../src/screens/session';
import { doc, syntheticPaper } from '../fixtures/make';
import { answerAll, importPack, synthKey } from './helpers';
import type { QuestionStat } from '../../src/lib/types';

let n = 0;
beforeEach(() => store.useDbName(`v2-${++n}`));

const DAY = 86_400_000;
const T0 = new Date(2026, 9, 1, 9, 0).getTime();

describe('mistakes bank: two in a row', () => {
  const step = (s: QuestionStat, correct: boolean, unsure = false, at = T0) => applyAnswer(s, { correct, unsure, timeMs: 1000, at, countSeen: true });
  it('wrong enters, two correct sure answers on the same day clear it, wrong resets the streak', () => {
    let s = step(emptyStat('p', 'q'), false).stat;
    expect(s.inBank).toBe(true);
    s = step(s, true, false, T0 + 60_000).stat;
    expect(s.inBank).toBe(true);
    s = step(s, false, false, T0 + 120_000).stat;
    expect(s.streak).toBe(0);
    s = step(s, true, false, T0 + 180_000).stat;
    const r = step(s, true, false, T0 + 240_000);
    expect(r.stat.inBank).toBe(false);
    expect(r.event).toBe('out');
  });
  it('right but Unsure enters the bank and does not count toward clearing', () => {
    let s = step(emptyStat('p', 'q'), true, true).stat;
    expect(s.inBank).toBe(true);
    s = step(s, true, false).stat;
    s = step(s, true, true).stat;
    expect(s.streak).toBe(0);
    expect(s.inBank).toBe(true);
  });
});

describe('retired Daily 10', () => {
  it('refuses new sessions while historical summaries and details still replay', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    await expect(createSession({ pack, type: 'daily' as never, mode: 'practice' }, T0)).rejects.toThrow(/retired|no longer|legacy/i);
    const paper = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' }, T0);
    await answerAll(paper.summary.id, (_i, q) => synthKey(q));
    await submitSession(paper.summary.id, false, T0 + 1000);
    const s = (await store.getSession(paper.summary.id))!;
    const d = (await store.getDetail(s.id))!;
    await store.saveSessionState({ ...s, type: 'daily', title: 'Daily 10' }, d);
    await rebuildStats(id);
    expect((await store.getSession(s.id))?.type).toBe('daily');
    expect((await store.getStats(id)).every((q) => q.timesSeen === 0)).toBe(true);
    expect((await store.getStats(id)).every((q) => q.attempts === 1)).toBe(true);
  });
});

describe('regrading and stats replay', () => {
  it('a corrected key regrades past sessions and rebuilds the bank', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 4)));
    const pack = (await store.getPack(id))!;
    const { summary } = await createSession({ pack, type: 'paper', mode: 'exam', paperId: 'p1' }, T0);
    await answerAll(summary.id, () => 0); // A A A A; key B C D A, so only q4 right
    expect((await submitSession(summary.id, false, T0))!.summary.correct).toBe(1);
    expect((await store.getStats(id)).filter((s) => s.inBank)).toHaveLength(3);
    const regraded = await setPaperKey(id, 'p1', [0, 0, 3, 0]);
    expect(regraded).toBe(1);
    const s = (await store.getSession(summary.id))!;
    expect(s.correct).toBe(3);
    expect((await store.getDetail(summary.id))!.key).toEqual([0, 0, 3, 0]);
    expect((await store.getStats(id)).filter((x) => x.inBank).map((x) => x.qid)).toEqual(['p1#3']);
  });
  it('replay reproduces the incremental stats exactly', async () => {
    const id = await importPack(doc(syntheticPaper('p1', 6), syntheticPaper('p2', 6)));
    const pack = (await store.getPack(id))!;
    let t = T0;
    const choices = [0, 1, 2, 3, 1, 2, 0, 3, 2, 1, 0, 0];
    for (let round = 0; round < 6; round++) {
      const type = round % 3 === 2 ? 'drill' : 'random';
      let created;
      try {
        created = await createSession({ pack, type, mode: 'exam', timer: { kind: 'total', minutes: 30 } }, t);
      } catch {
        continue;
      }
      await answerAll(created.summary.id, (i) => choices[(i + round) % choices.length] ?? null, { unsure: (i) => (i + round) % 5 === 0 });
      await submitSession(created.summary.id, round === 4, t);
      t += DAY / 3;
    }
    const before = (await store.getStats(id)).sort((a, b) => a.key.localeCompare(b.key));
    const eventsBefore = (await store.getBankEvents(id)).length;
    await rebuildStats(id);
    const after = (await store.getStats(id)).sort((a, b) => a.key.localeCompare(b.key));
    expect(after).toEqual(before);
    expect((await store.getBankEvents(id)).length).toBe(eventsBefore);
  });
  it('sessions awaiting a key are ignored by the replay', () => {
    const out = replayStats('p', [{ s: { id: 's', packId: 'p', type: 'paper', mode: 'exam', title: '', status: 'submitted', partial: false, startedAt: 0, endedAt: 1, updatedAt: 1, total: 1, answered: 1, correct: 0, timeMs: 1, awaitingKey: true }, d: { id: 's', packId: 'p', questionIds: ['x#1'], sources: {}, answers: [{ qid: 'x#1', choice: 0, first: 0, changes: 0, timeMs: 1, flagged: false, unsure: false, checked: false, locked: false }], current: 0, shuffled: false, key: [null] } }]);
    expect(out.stats).toEqual([]);
  });
});

describe('grade boundaries', () => {
  const b = [{ grade: 'A', min: 31 }, { grade: 'B', min: 27 }, { grade: 'C', min: 23 }];
  it('reports the grade and marks to the next one', () => {
    expect(gradeFor(b, 28)).toEqual({ grade: 'B', next: { grade: 'A', marks: 3 } });
    expect(gradeFor(b, 31)).toEqual({ grade: 'A', next: null });
    expect(gradeFor(b, 10)).toEqual({ grade: null, next: { grade: 'C', marks: 13 } });
    expect(gradeFor(undefined, 10)).toBeNull();
  });
  it('validator reads both forms and rejects marks beyond the paper', () => {
    expect(parseBoundaries({ B: 27, A: 31 }, 40)).toEqual([{ grade: 'A', min: 31 }, { grade: 'B', min: 27 }]);
    expect(parseBoundaries([{ grade: 'A', min: 31 }], 40)).toEqual([{ grade: 'A', min: 31 }]);
    expect(typeof parseBoundaries({ A: 41 }, 40)).toBe('string');
    const r = validateDoc({ papers: [{ ...syntheticPaper('p1', 4), gradeBoundaries: { A: 9 } }] });
    expect(r.errors[0]?.path).toBe('papers[0].gradeBoundaries');
  });
});

describe('mark scheme reader', () => {
  it('reads a Cambridge-style answer column and leaves gaps unknown', () => {
    const text = 'Cambridge International AS & A Level 9702/12 Mark Scheme Page 2 of 3 Question Answer Marks 1 B 1 2 D 1 3 A 1 Page 3 of 3 Question Answer Marks 5 C 1 6 B 1';
    expect(parseMarkScheme(text, 6)).toEqual({ key: [1, 3, 0, null, 2, 1], found: 5 });
  });
  it('ignores lowercase words and letters beyond the option count', () => {
    expect(parseMarkScheme('1 a 1 E 2 C', 2, 4).key).toEqual([null, 2]);
  });
});

describe('timer colour', () => {
  it('is ink above half, OKLCH mixes toward warn then bad, never the accent', () => {
    expect(timerColour(0.8)).toBe('var(--ink)');
    expect(timerColour(0.4)).toMatch(/oklch.*status-warn.*ink/);
    expect(timerColour(0.2)).toMatch(/oklch.*status-bad.*status-warn/);
    expect(timerColour(0.05)).toBe('var(--status-bad)');
    for (let f = 0; f <= 1; f += 0.01) expect(timerColour(f)).not.toMatch(/accent|orange/);
  });
});
