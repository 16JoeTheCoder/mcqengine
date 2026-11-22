import { describe, expect, it } from 'vitest';
import { applyChoice, practiceState, practiceTally, unansweredAt } from '../../src/lib/engine/answer';
import type { AnswerRecord } from '../../src/lib/types';

const rec = (over: Partial<AnswerRecord> = {}): AnswerRecord => ({
  qid: 'q1', choice: null, first: null, changes: 0, timeMs: 0, flagged: false, unsure: false, checked: false, locked: false, ...over,
});

describe('applyChoice exam mode', () => {
  it('first choice sets choice and first', () => {
    const r = rec();
    expect(applyChoice(r, 2, 4, true)).toBe('set');
    expect(r.choice).toBe(2);
    expect(r.first).toBe(2);
    expect(r.changes).toBe(0);
    expect(r.checked).toBe(false);
  });

  it('a different option increments changes and keeps first', () => {
    const r = rec();
    applyChoice(r, 1, 4, true);
    expect(applyChoice(r, 3, 4, true)).toBe('set');
    expect(r.choice).toBe(3);
    expect(r.first).toBe(1);
    expect(r.changes).toBe(1);
  });

  it('the same option again clears to null', () => {
    const r = rec();
    applyChoice(r, 1, 4, true);
    expect(applyChoice(r, 1, 4, true)).toBe('cleared');
    expect(r.choice).toBeNull();
    expect(r.first).toBe(1);
  });

  it('choosing after clearing sets it and first stays the original', () => {
    const r = rec();
    applyChoice(r, 1, 4, true);
    applyChoice(r, 1, 4, true);
    expect(applyChoice(r, 2, 4, true)).toBe('set');
    expect(r.choice).toBe(2);
    expect(r.first).toBe(1);
  });
});

describe('applyChoice practice mode', () => {
  it('sets choice and checks it', () => {
    const r = rec();
    expect(applyChoice(r, 0, 4, false)).toBe('set');
    expect(r.choice).toBe(0);
    expect(r.first).toBe(0);
    expect(r.checked).toBe(true);
  });

  it('a second call is ignored and cannot clear', () => {
    const r = rec();
    applyChoice(r, 0, 4, false);
    expect(applyChoice(r, 0, 4, false)).toBe('ignored');
    expect(applyChoice(r, 1, 4, false)).toBe('ignored');
    expect(r.choice).toBe(0);
    expect(r.changes).toBe(0);
  });
});

describe('applyChoice guards', () => {
  it('ignores locked records', () => {
    const r = rec({ locked: true });
    expect(applyChoice(r, 1, 4, true)).toBe('ignored');
    expect(r).toEqual(rec({ locked: true }));
  });

  it('ignores checked records', () => {
    const r = rec({ checked: true, choice: 2, first: 2 });
    expect(applyChoice(r, 2, 4, true)).toBe('ignored');
    expect(r).toEqual(rec({ checked: true, choice: 2, first: 2 }));
  });

  it.each([-1, 4, 5, 1.5, NaN, Infinity])('ignores invalid index %s', (i) => {
    const r = rec();
    expect(applyChoice(r, i, 4, true)).toBe('ignored');
    expect(r).toEqual(rec());
  });
});

describe('unansweredAt', () => {
  it('lists indexes with no choice', () => {
    const a = [rec({ choice: 1 }), rec(), rec({ choice: 0 }), rec()];
    expect(unansweredAt(a)).toEqual([1, 3]);
  });

  it('excludes a flagged answered question and includes a flagged unanswered one', () => {
    const a = [rec({ choice: 1, flagged: true }), rec({ flagged: true })];
    expect(unansweredAt(a)).toEqual([1]);
  });

  it('is empty when all are answered', () => {
    expect(unansweredAt([rec({ choice: 0 })])).toEqual([]);
  });
});

describe('practiceTally', () => {
  const keys: Record<string, number | null | undefined> = { a: 0, b: 1, c: null, d: undefined, e: 2 };
  const keyOf = (qid: string) => keys[qid];

  it('counts right and wrong only for checked answers with a known key', () => {
    const a = [
      rec({ qid: 'a', choice: 0, checked: true }), // right
      rec({ qid: 'b', choice: 3, checked: true }), // wrong
      rec({ qid: 'c', choice: 1, checked: true }), // null key
      rec({ qid: 'd', choice: 1, checked: true }), // undefined key
      rec({ qid: 'e', choice: 2, checked: false }), // unchecked
    ];
    expect(practiceTally(a, keyOf)).toEqual({ right: 1, wrong: 1, checked: 2, pct: 50 });
  });

  it('rounds the percentage', () => {
    const a = [
      rec({ qid: 'a', choice: 0, checked: true }),
      rec({ qid: 'a', choice: 0, checked: true }),
      rec({ qid: 'b', choice: 0, checked: true }),
    ];
    expect(practiceTally(a, keyOf).pct).toBe(67);
  });

  it('pct is null when nothing counted', () => {
    expect(practiceTally([], keyOf)).toEqual({ right: 0, wrong: 0, checked: 0, pct: null });
    expect(practiceTally([rec({ qid: 'a', choice: 0 })], keyOf).pct).toBeNull();
  });

  it('passes the index to keyOf', () => {
    const seen: number[] = [];
    practiceTally([rec({ choice: 0, checked: true }), rec({ choice: 0, checked: true })], (_q, i) => { seen.push(i); return 0; });
    expect(seen).toEqual([0, 1]);
  });
});

describe('practiceState', () => {
  it('returns right and wrong for checked answers with a key', () => {
    expect(practiceState(rec({ choice: 1, checked: true }), 1)).toBe('right');
    expect(practiceState(rec({ choice: 0, checked: true }), 1)).toBe('wrong');
  });

  it('returns null when unchecked, unanswered or keyless', () => {
    expect(practiceState(rec({ choice: 1 }), 1)).toBeNull();
    expect(practiceState(rec({ checked: true }), 1)).toBeNull();
    expect(practiceState(rec({ choice: 1, checked: true }), null)).toBeNull();
    expect(practiceState(rec({ choice: 1, checked: true }), undefined)).toBeNull();
  });
});
