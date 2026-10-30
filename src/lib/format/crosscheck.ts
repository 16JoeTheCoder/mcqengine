import { markupToText } from './markup';
import type { NPaper } from './validate';

/** Numbers worth checking: at least two characters, or a decimal (so single digits and "A" do not count). */
function numbersIn(s: string): string[] {
  return [...new Set((s.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => n.length >= 2))];
}

const squash = (s: string) => s.replace(/\s+/g, '').replace(/[−–]/g, '-');

export interface CrossCheckIssue {
  n: number;
  missing: string[];
  checked: number;
}

/**
 * Silent mis-transcription guard. Every number in a typed question (stem, options, table) should
 * appear somewhere in the question paper's text. Questions where at least two numbers, and more
 * than half of them, are missing are flagged for a look in the PDF before import. Scanned PDFs
 * have no text; the caller skips the check when the text is nearly empty.
 */
export function crossCheck(paper: NPaper, pageTexts: string[]): CrossCheckIssue[] {
  const all = squash(pageTexts.join(' '));
  if (all.length < 200) return [];
  const out: CrossCheckIssue[] = [];
  for (const q of paper.questions) {
    const text = [q.stem, ...(q.options ?? []).map((o) => o.text), ...(q.table?.rows.flat() ?? [])].filter(Boolean).map((t) => markupToText(t)).join(' ');
    const nums = numbersIn(text);
    if (nums.length < 2) continue;
    const missing = nums.filter((x) => !all.includes(x));
    if (missing.length >= 2 && missing.length / nums.length > 0.5) out.push({ n: q.n, missing, checked: nums.length });
  }
  return out;
}
