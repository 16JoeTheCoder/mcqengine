/**
 * A small, tested parser for exam-board file names. Cambridge names look like
 * `9702_s23_qp_12.pdf` (syllabus, series letter + year, kind, paper and variant). Anything it does
 * not recognise falls back to a tidy title from the name, so it never blocks an import.
 */
export interface ParsedName {
  code?: string;
  subject?: string;
  series?: 'Feb/March' | 'May/June' | 'Oct/Nov';
  year?: number;
  kind?: 'qp' | 'ms' | 'in' | 'er' | 'gt';
  paper?: string;
  /** Stable paper id in the prompt's convention: `9702-s23-12`. */
  id?: string;
  title: string;
  group: string[];
}

const SERIES = { m: 'Feb/March', s: 'May/June', w: 'Oct/Nov' } as const;

/** Common Cambridge syllabus codes. Unknown codes still parse; they just get no subject name. */
export const SUBJECTS: Record<string, string> = {
  '9702': 'Physics', '9701': 'Chemistry', '9700': 'Biology', '9709': 'Mathematics', '9231': 'Further Mathematics',
  '9708': 'Economics', '9609': 'Business', '9618': 'Computer Science', '9706': 'Accounting', '9990': 'Psychology',
  '0625': 'Physics', '0620': 'Chemistry', '0610': 'Biology', '0580': 'Mathematics', '0455': 'Economics',
  '0450': 'Business Studies', '0478': 'Computer Science', '0653': 'Combined Science', '0654': 'Co-ordinated Sciences',
};

export function parseFileName(file: string): ParsedName {
  const base = (file.split(/[\\/]/).pop() ?? file).replace(/\.(pdf|zip|json)$/i, '').replace(/\.dmc$/i, '');
  const m = /^(\d{4})[_\s-]+([msw])(\d{2})[_\s-]+(qp|ms|in|er|gt)(?:[_\s-]+(\d{1,2}))?$/i.exec(base.trim());
  if (!m) {
    const title = base.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled paper';
    return { title: title.charAt(0).toUpperCase() + title.slice(1), group: [] };
  }
  const [, code, s, yy, kind, paper] = m as unknown as [string, string, keyof typeof SERIES, string, ParsedName['kind'], string | undefined];
  const series = SERIES[s.toLowerCase() as keyof typeof SERIES];
  const year = 2000 + Number(yy);
  const out: ParsedName = {
    code,
    series,
    year,
    kind: kind?.toLowerCase() as ParsedName['kind'],
    title: `${series} ${year}${paper ? ` Paper ${paper}` : ''}`,
    group: [String(year), series],
  };
  if (SUBJECTS[code]) out.subject = SUBJECTS[code];
  if (paper) {
    out.paper = paper;
    out.id = `${code}-${s.toLowerCase()}${yy}-${paper}`;
  }
  return out;
}

/** Pairs question papers with their mark schemes by code, series and paper number. */
export function pairFiles<T extends { name: string }>(files: T[]): { papers: { qp: T; ms?: T; parsed: ParsedName }[]; unpaired: T[] } {
  const parsed = files.map((f) => ({ f, p: parseFileName(f.name) }));
  const schemes = parsed.filter((x) => x.p.kind === 'ms');
  const used = new Set<T>();
  const papers = parsed
    .filter((x) => x.p.kind !== 'ms')
    .map((x) => {
      const ms = x.p.id ? schemes.find((y) => y.p.id === x.p.id)?.f : undefined;
      if (ms) used.add(ms);
      return ms ? { qp: x.f, ms, parsed: x.p } : { qp: x.f, parsed: x.p };
    });
  return { papers, unpaired: schemes.filter((y) => !used.has(y.f)).map((y) => y.f) };
}
