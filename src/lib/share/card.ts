import type { SessionSummary } from '../types';
import { mean, paperScore, qualifying } from '../stats/core';

export interface CardData {
  exam: string;
  avg: number;
  marks: { correct: number; total: number }[];
  lo: number;
  hi: number;
  /** Latest session: minutes used and the minutes allowed. */
  usedMin: number;
  capMin: number | null;
  date: string;
}

/**
 * Data for the shareable card: the last three qualifying sessions (complete, not partial, Exam
 * mode, paper or random). Partials never count, so the number is never flattering noise.
 * Null until three exist.
 */
export function cardData(exam: string, sessions: SessionSummary[]): CardData | null {
  const q = qualifying(sessions).slice(-3);
  if (q.length < 3) return null;
  const scores = q.map(paperScore);
  const last = q[q.length - 1]!;
  return {
    exam,
    avg: mean(scores),
    marks: q.map((s) => ({ correct: s.correct, total: s.total })),
    lo: Math.min(...scores),
    hi: Math.max(...scores),
    usedMin: Math.max(1, Math.round(last.timeMs / 60_000)),
    capMin: last.timer ? Math.round(last.timer.totalMs / 60_000) : null,
    date: new Date(last.endedAt ?? last.updatedAt).toISOString().slice(0, 10),
  };
}

/** "completed in 52 of 75 min", or "used only 41 min of 75" when at most 60% of the time was used. */
export function timeLine(c: CardData): string {
  if (!c.capMin) return `completed in ${c.usedMin} min`;
  return c.usedMin <= c.capMin * 0.6 ? `used only ${c.usedMin} min of ${c.capMin}` : `completed in ${c.usedMin} of ${c.capMin} min`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (x: number) => Math.round(x * 100);

/**
 * The card as SVG, 1200 x 675, ink on paper with one orange point (the lockup's cap). Colours are
 * the light-theme tokens, written out because an exported image cannot read CSS variables.
 */
export function cardSvg(c: CardData, lockup: string, fontCss = ''): string {
  const INK = '#0D0E10';
  const MUTED = '#4A4D53';
  const LINE = '#D3D0C7';
  const PAPER = '#F3F2EE';
  const x0 = 72;
  const barX = 640;
  const barW = 488;
  const at = (v: number) => barX + barW * v;
  const inner = lockup.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>[\s\S]*?<\/title>/, '');
  const exam = c.exam.length > 40 ? `${c.exam.slice(0, 39)}…` : c.exam;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="675" viewBox="0 0 1200 675">
<style>${fontCss} text{font-family:'Space Grotesk','Helvetica Neue',Arial,sans-serif;fill:${INK}} .m{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace}</style>
<rect width="1200" height="675" fill="${PAPER}"/>
<text x="${x0}" y="104" font-size="22" font-weight="500" letter-spacing="1.8" fill="${MUTED}" style="fill:${MUTED}">LAST THREE EXAM SESSIONS</text>
<text x="${x0}" y="164" font-size="48" font-weight="700" letter-spacing="-1.4">${esc(exam)}</text>
<text x="${x0 - 8}" y="430" font-size="240" font-weight="300" letter-spacing="-9.6">${pct(c.avg)}<tspan font-size="96" letter-spacing="0" dx="12">%</tspan></text>
<text x="${x0}" y="500" font-size="26" font-weight="400" style="fill:${MUTED}">average score</text>
<text x="${barX}" y="250" font-size="22" font-weight="500" letter-spacing="1.8" style="fill:${MUTED}">MARKS</text>
<text x="${barX}" y="296" font-size="36" font-weight="500" class="m">${c.marks.map((m) => `${m.correct}/${m.total}`).join('  ')}</text>
<text x="${barX}" y="372" font-size="22" font-weight="500" letter-spacing="1.8" style="fill:${MUTED}">RANGE ${pct(c.lo)}–${pct(c.hi)}%</text>
<line x1="${barX}" y1="410" x2="${barX + barW}" y2="410" stroke="${LINE}" stroke-width="2"/>
<line x1="${at(c.lo)}" y1="410" x2="${at(c.hi) + 0.01}" y2="410" stroke="${INK}" stroke-width="8"/>
${c.marks.map((m) => `<rect x="${at(m.correct / m.total) - 3}" y="394" width="6" height="32" fill="${INK}"/>`).join('')}
<text x="${barX}" y="448" font-size="18" class="m" style="fill:${MUTED}">0</text>
<text x="${barX + barW}" y="448" font-size="18" class="m" text-anchor="end" style="fill:${MUTED}">100</text>
<text x="${barX}" y="506" font-size="28" font-weight="400">${esc(timeLine(c))}</text>
<line x1="${x0}" y1="572" x2="1128" y2="572" stroke="${LINE}" stroke-width="2"/>
<text x="${x0}" y="622" font-size="22" class="m" style="fill:${MUTED}">DMC · ${c.date}</text>
<g transform="translate(908 588) scale(0.4375)">${inner}</g>
</svg>`;
}
