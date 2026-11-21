import type { AnswerRecord } from '../types';

/**
 * Answering rules shared by DMC mode and PDF mode.
 * Exam: choosing the selected option again clears it (no answer). Practice: the first choice is
 * checked and locked at once, so it cannot be cleared.
 */
export type ChoiceResult = 'set' | 'cleared' | 'ignored';

export function applyChoice(rec: AnswerRecord, i: number, optionCount: number, exam: boolean): ChoiceResult {
  if (rec.locked || rec.checked || !Number.isInteger(i) || i < 0 || i >= optionCount) return 'ignored';
  if (exam && rec.choice === i) {
    rec.choice = null;
    rec.changes++;
    return 'cleared';
  }
  if (rec.choice === null && rec.first === null) rec.first = i;
  else if (rec.choice !== i) rec.changes++;
  rec.choice = i;
  if (!exam) rec.checked = true;
  return 'set';
}

/** Submit warns about unanswered questions only. A flag is a marker, never a warning. */
export function unansweredAt(answers: readonly AnswerRecord[]): number[] {
  return answers.flatMap((a, i) => (a.choice === null ? [i] : []));
}

export interface Tally { right: number; wrong: number; checked: number; pct: number | null }

/** Practice feedback: right and wrong among checked answers with a known key. */
export function practiceTally(answers: readonly AnswerRecord[], keyOf: (qid: string, i: number) => number | null | undefined): Tally {
  let right = 0;
  let wrong = 0;
  answers.forEach((a, i) => {
    if (!a.checked || a.choice === null) return;
    const k = keyOf(a.qid, i);
    if (k === null || k === undefined) return;
    if (k === a.choice) right++;
    else wrong++;
  });
  const checked = right + wrong;
  return { right, wrong, checked, pct: checked ? Math.round((right / checked) * 100) : null };
}

/** Practice state of one answer, for the grid and the answer sheet. */
export function practiceState(a: AnswerRecord, key: number | null | undefined): 'right' | 'wrong' | null {
  if (!a.checked || a.choice === null || key === null || key === undefined) return null;
  return a.choice === key ? 'right' : 'wrong';
}
