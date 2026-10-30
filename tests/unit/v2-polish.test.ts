import { describe, expect, it } from 'vitest';
import { cardData, cardSvg, timeLine } from '../../src/lib/share/card';
import { personalBest } from '../../src/screens/results';
import { filterCommands } from '../../src/screens/palette';
import type { SessionSummary } from '../../src/lib/types';
import lockup from '../../brand/tab-lockup-light.svg?raw';

let k = 0;
const sess = (correct: number, o: Partial<SessionSummary> = {}): SessionSummary => ({
  id: `s${++k}`, packId: 'p', type: 'paper', mode: 'exam', paperId: 'p1', title: 'P1', status: 'submitted', partial: false,
  startedAt: k * 1000, endedAt: k * 1000, updatedAt: k * 1000, total: 40, answered: 40, correct, timeMs: 52 * 60_000,
  timer: { kind: 'none', capMs: 75 * 60_000, totalMs: 75 * 60_000 }, ...o,
});

describe('result card', () => {
  it('needs three qualifying sessions and never counts partials, drills or practice', () => {
    expect(cardData('Physics', [sess(30), sess(31)])).toBeNull();
    const c = cardData('Physics', [sess(10), sess(30), sess(40, { partial: true, answered: 20 }), sess(36, { type: 'drill' }), sess(39, { mode: 'practice' }), sess(32), sess(34)])!;
    expect(c.marks.map((m) => m.correct)).toEqual([30, 32, 34]);
    expect(c.avg).toBeCloseTo(0.8);
    expect([c.lo, c.hi]).toEqual([0.75, 0.85]);
  });
  it('says "used only" when well under time, "completed in" otherwise', () => {
    expect(timeLine({ ...cardData('x', [sess(1), sess(2), sess(3)])! })).toBe('completed in 52 of 75 min');
    expect(timeLine({ ...cardData('x', [sess(1), sess(2), sess(3, { timeMs: 41 * 60_000 })])! })).toBe('used only 41 min of 75');
  });
  it('is ink and paper with exactly one orange point (the lockup cap), and escapes text', () => {
    const svg = cardSvg(cardData('<Physics & "Maths">', [sess(30), sess(32), sess(34)])!, lockup);
    expect(svg.match(/#FF5B1F/gi)).toHaveLength(1);
    expect(svg).toContain('&#60;Physics &#38; &#34;Maths&#34;&#62;');
    expect(svg).toMatch(/>80<tspan/);
  });
});

describe('personal best', () => {
  it('only from the third attempt onward, only when beating every earlier attempt', () => {
    const a = sess(30);
    const b = sess(32);
    const c = sess(33);
    expect(personalBest(b, [a, b])).toBeNull();
    expect(personalBest(c, [a, b, c])).toBeCloseTo(0.8);
    const d = sess(31);
    expect(personalBest(d, [a, b, c, d])).toBeNull();
    const e = sess(35, { partial: true, answered: 39 });
    expect(personalBest(e, [a, b, c, e])).toBeNull();
    const f = sess(38, { mode: 'practice' });
    expect(personalBest(f, [a, b, c, f])).toBeNull();
  });
});

describe('command palette', () => {
  const cmds = ['Open Physics 9702', 'Daily 10 in Physics 9702', 'Settings', 'Export everything'].map((label) => ({ id: label, label, run: () => {} }));
  it('ranks prefix, then word prefix, then substring', () => {
    expect(filterCommands(cmds, 'set').map((c) => c.label)).toEqual(['Settings']);
    expect(filterCommands(cmds, 'phy').map((c) => c.label)).toEqual(['Open Physics 9702', 'Daily 10 in Physics 9702']);
    expect(filterCommands(cmds, 'zzz')).toEqual([]);
    expect(filterCommands(cmds, '')).toHaveLength(4);
  });
});
