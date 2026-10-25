// Synthetic fixtures only. No real exam content.
export function syntheticPaper(id: string, count = 40, opts: { answers?: boolean; from?: number; to?: number; title?: string } = {}) {
  const from = opts.from ?? 1;
  const to = opts.to ?? count;
  const letters = 'ABCD';
  const questions = [];
  for (let n = from; n <= to; n++)
    questions.push({
      n,
      stem: `Synthetic question ${n}: a body of mass ${n}.0 kg moves at ${n} m s^{-1}. Which value is correct?`,
      options: [`${n} J`, `${n * 2} J`, `${n * 3} J`, `${n * 4} J`],
      answer: opts.answers === false ? null : letters[n % 4],
    });
  return { id, title: opts.title ?? `Synthetic ${id}`, group: ['2025', 'May/June'], questionCount: count, timeLimitMinutes: 60, optionCount: 4, questions };
}
export const doc = (...papers: unknown[]) => ({ format: 'dmc-pack/1', papers });
