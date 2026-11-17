/**
 * Canonical Cambridge paper keys, shared by the app and the Worker.
 *
 * A key is Cambridge's own file stem: `<syllabus>_<series><yy>_<type>_<variant>`, for example
 * `9702_s24_qp_12` (question paper) and `9702_s24_ms_12` (its mark scheme). The key is worked out
 * from a file name or the cover page text, never from an ID an AI importer wrote, because
 * different AIs format IDs differently. A question's ID is `<qp key>#<number>`.
 */
export type PaperType = 'qp' | 'ms';
export interface PaperKeyParts { syllabus: string; series: 'm' | 's' | 'w'; yy: string; type: PaperType; variant: string }

export const PAPER_KEY_RE = /^(\d{4})_([msw])(\d{2})_(qp|ms)_(\d{1,2})$/;
export const isPaperKey = (s: unknown): s is string => typeof s === 'string' && PAPER_KEY_RE.test(s);

export function formatPaperKey(p: PaperKeyParts): string {
  return `${p.syllabus}_${p.series}${p.yy}_${p.type}_${p.variant.padStart(2, '0')}`;
}

export function parsePaperKey(key: string): PaperKeyParts | null {
  const m = PAPER_KEY_RE.exec(key);
  return m ? { syllabus: m[1]!, series: m[2] as PaperKeyParts['series'], yy: m[3]!, type: m[4] as PaperType, variant: m[5]! } : null;
}

/** The question-paper key for a key of either type. */
export const qpKeyOf = (key: string) => key.replace(/_ms_/, '_qp_');
/** The mark-scheme key for a key of either type. */
export const msKeyOf = (key: string) => key.replace(/_qp_/, '_ms_');
export const questionIdOf = (qpKey: string, n: number) => `${qpKey}#${n}`;

/**
 * From a file name such as `9702_s24_qp_12.pdf`, `9702-s24-qp-12.pdf` or `9702 s24 ms 12 (1).pdf`.
 * Only question papers and mark schemes have keys; inserts, examiner reports and grade
 * thresholds return null. A single-digit variant is padded (`_1` is not a real variant, so it
 * stays as `01`, which then needs confirmation in the import review).
 */
export function paperKeyFromName(name: string): string | null {
  const base = (name.split(/[\\/]/).pop() ?? name).replace(/\.(pdf|zip|json)$/i, '').replace(/\s*\(\d+\)$/, '').trim();
  const m = /^(\d{4})[_\s-]+([msw])(\d{2})[_\s-]+(qp|ms)[_\s-]+(\d{1,2})$/i.exec(base);
  if (!m) return null;
  return formatPaperKey({ syllabus: m[1]!, series: m[2]!.toLowerCase() as PaperKeyParts['series'], yy: m[3]!, type: m[4]!.toLowerCase() as PaperType, variant: m[5]! });
}

const SERIES_WORDS: [RegExp, PaperKeyParts['series']][] = [
  [/\bfebruary\s*\/?\s*march\b|\bfeb\s*\/\s*mar\b/i, 'm'],
  [/\bmay\s*\/?\s*june\b/i, 's'],
  [/\boctober\s*\/?\s*november\b|\boct\s*\/\s*nov\b/i, 'w'],
];

/**
 * From the cover page text of a Cambridge paper: "PHYSICS 9702/12 Paper 1 Multiple Choice
 * May/June 2024" or "9702/12/M/J/24" in the footer. Mark schemes say "MARK SCHEME". Returns null
 * unless syllabus, variant, series and year are all present and unambiguous.
 */
export function paperKeyFromCover(text: string): string | null {
  const t = text.replace(/\s+/g, ' ');
  const type: PaperType = /\bmark scheme\b/i.test(t) ? 'ms' : 'qp';
  // Footer form: 9702/12/M/J/24 (also F/M and O/N).
  const footer = /\b(\d{4})\/(\d{2})\/(F\/M|M\/J|O\/N)\/(\d{2})\b/i.exec(t);
  if (footer) {
    const series = ({ 'F/M': 'm', 'M/J': 's', 'O/N': 'w' } as const)[footer[3]!.toUpperCase() as 'F/M' | 'M/J' | 'O/N'];
    return formatPaperKey({ syllabus: footer[1]!, series, yy: footer[4]!, type, variant: footer[2]! });
  }
  const codes = [...new Set([...t.matchAll(/\b(\d{4})\/(\d{2})\b/g)].map((m) => `${m[1]}/${m[2]}`))];
  if (codes.length !== 1) return null;
  const [syllabus, variant] = codes[0]!.split('/') as [string, string];
  const series = SERIES_WORDS.filter(([re]) => re.test(t)).map(([, s]) => s);
  const years = [...new Set([...t.matchAll(/\b20(\d{2})\b/g)].map((m) => m[1]!))];
  if (series.length !== 1 || years.length !== 1) return null;
  return formatPaperKey({ syllabus, series: series[0]!, yy: years[0]!, type, variant });
}

/** A readable title for a key: "May/June 2024 Paper 12". */
export function paperKeyTitle(key: string): string {
  const p = parsePaperKey(key);
  if (!p) return key;
  const series = { m: 'Feb/March', s: 'May/June', w: 'Oct/Nov' }[p.series];
  return `${series} 20${p.yy} Paper ${p.variant}`;
}
