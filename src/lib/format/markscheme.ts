/**
 * Reads a multiple-choice key out of mark-scheme text (as extracted from a PDF). Cambridge mark
 * schemes print rows of "question  answer  marks", so the text reads "1 B 1 2 D 1 3 A 1 …". The
 * reader looks for each question number in order, followed by a single option letter; anything
 * it cannot find stays unknown. The result is only ever a suggestion: the app always shows it as
 * a letter grid for the student to confirm.
 */
export function parseMarkScheme(text: string, count: number, optionCount = 4): { key: (number | null)[]; found: number } {
  const letters = 'ABCDE'.slice(0, optionCount);
  const tokens = text
    .replace(/[\u00a0\u2009]/g, ' ')
    .split(/[\s|]+/)
    .map((t) => t.replace(/^[([]|[)\].,:;]$/g, ''))
    .filter(Boolean);
  const key: (number | null)[] = new Array(count).fill(null);
  let pos = 0;
  let found = 0;
  for (let q = 1; q <= count; q++) {
    for (let i = pos; i < tokens.length - 1; i++) {
      if (tokens[i] !== String(q)) continue;
      const next = tokens[i + 1] as string;
      if (next.length === 1 && letters.includes(next.toUpperCase()) && next === next.toUpperCase()) {
        key[q - 1] = letters.indexOf(next);
        found++;
        pos = i + 2;
        break;
      }
    }
  }
  return { key, found };
}
