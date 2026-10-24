import { TIME_BINS, type AnswerRecord, type SessionAggregates } from '../types';

export interface GradedItem {
  qid: string;
  index: number;
  correct: boolean;
  unsure: boolean;
  timeMs: number;
}

export interface GradeResult {
  answered: number;
  correct: number;
  partial: boolean;
  timeMs: number;
  items: GradedItem[];
  agg: SessionAggregates;
}

/**
 * Grades a session. Only answered questions are graded; unanswered ones are not graded and
 * return to the unseen pool. A manual submit with unanswered questions is partial. An
 * auto-submit at time zero is a complete attempt: unanswered questions count against the paper
 * score (correct / full length) but are not graded as individual answers.
 */
export function gradeSession(
  answers: AnswerRecord[],
  key: (qid: string) => number | null | undefined,
  auto: boolean,
): GradeResult {
  const total = answers.length;
  const items: GradedItem[] = [];
  const thirds: [number, number][] = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  const sure: [number, number] = [0, 0];
  const unsureAcc: [number, number] = [0, 0];
  const changes = { helped: 0, hurt: 0, neutral: 0 };
  const hist = new Array<number>(TIME_BINS.length + 1).fill(0);
  let timeMs = 0;

  answers.forEach((a, index) => {
    timeMs += Math.max(0, a.timeMs);
    if (a.choice === null) return;
    const k = key(a.qid);
    if (k === null || k === undefined) return;
    const correct = a.choice === k;
    items.push({ qid: a.qid, index, correct, unsure: a.unsure, timeMs: a.timeMs });
    const t = thirds[Math.min(2, Math.floor((index * 3) / Math.max(1, total)))] as [number, number];
    t[1]++;
    if (correct) t[0]++;
    const bucket = a.unsure ? unsureAcc : sure;
    bucket[1]++;
    if (correct) bucket[0]++;
    if (a.changes > 0 && a.first !== null) {
      const firstRight = a.first === k;
      if (!firstRight && correct) changes.helped++;
      else if (firstRight && !correct) changes.hurt++;
      else changes.neutral++;
    }
    const sec = a.timeMs / 1000;
    let bin = TIME_BINS.findIndex((edge) => sec < edge);
    if (bin < 0) bin = TIME_BINS.length;
    hist[bin] = (hist[bin] ?? 0) + 1;
  });

  const bySlow = items.slice().sort((x, y) => y.timeMs - x.timeMs);
  const nSlow = Math.ceil(bySlow.length / 4);
  const slowest: [number, number] = [0, 0];
  const rest: [number, number] = [0, 0];
  bySlow.forEach((it, i) => {
    const b = i < nSlow ? slowest : rest;
    b[1]++;
    if (it.correct) b[0]++;
  });

  const answered = items.length;
  const correct = items.filter((i) => i.correct).length;
  return {
    answered,
    correct,
    partial: !auto && answered < total,
    timeMs,
    items,
    agg: { thirds, sure, unsureAcc, changes, slowest, rest, hist },
  };
}
