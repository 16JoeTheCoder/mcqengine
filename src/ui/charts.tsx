import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

/** Measures a container's width so charts draw at true pixel size (crisp text, fixed height). */
function useWidth<T extends HTMLElement>(): [preact.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e?.contentRect.width ?? 0)));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function Frame({ height, label, children }: { height: number; label: string; children: (w: number) => ComponentChildren }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  return (
    <div ref={ref} class="chart-box" style={{ height: `${height}px` }}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={label}>
          {children(w)}
        </svg>
      )}
    </div>
  );
}

const niceTicks = (lo: number, hi: number, n = 4) => {
  const span = hi - lo || 1;
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
};

export interface Series {
  label: string;
  points: { x: number; y: number }[];
  kind: 'main' | 'raw' | 'dashed';
}

const PAD = { l: 44, r: 16, t: 12, b: 36 };

/**
 * Line chart with optional uncertainty band. The y-axis auto-fits with padding unless
 * `trueScale` is set (then 0 to yMax). Lines carry direct labels at their end.
 */
export function LineChart({
  series,
  band,
  height = 260,
  yFormat,
  xLabel,
  yLabel,
  trueScale,
  yMax = 1,
  label,
}: {
  series: Series[];
  band?: { x: number; lo: number; hi: number }[];
  height?: number;
  yFormat: (v: number) => string;
  xLabel: string;
  yLabel: string;
  trueScale?: boolean;
  yMax?: number;
  label: string;
}) {
  const all = series.flatMap((s) => s.points);
  const bandYs = band?.flatMap((b) => [b.lo, b.hi]) ?? [];
  const xs = all.map((p) => p.x);
  const ys = [...all.map((p) => p.y), ...bandYs];
  let lo = Math.min(...ys);
  let hi = Math.max(...ys);
  if (trueScale) {
    lo = 0;
    hi = yMax;
  } else {
    // Round outwards to tenths of the scale, so every point sits inside a gridline.
    const step = yMax / 10;
    lo = Math.max(0, Math.floor((lo - step * 0.3) / step) * step);
    hi = Math.min(yMax, Math.ceil((hi + step * 0.3) / step) * step);
    if (hi - lo < step * 2) hi = Math.min(yMax, lo + step * 2);
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  return (
    <Frame height={height} label={label}>
      {(w) => {
        const iw = w - PAD.l - PAD.r - 72;
        const ih = height - PAD.t - PAD.b;
        const sx = (x: number) => PAD.l + (x1 === x0 ? iw / 2 : ((x - x0) / (x1 - x0)) * iw);
        const sy = (y: number) => PAD.t + ih - ((y - lo) / (hi - lo || 1)) * ih;
        const path = (pts: { x: number; y: number }[]) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
        const ticks = niceTicks(lo, hi);
        const xTicks = niceTicks(x0, x1, Math.min(6, Math.max(1, x1 - x0))).filter((t) => Number.isInteger(t));
        return (
          <g font-family="var(--font-sans)" font-size="12">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={PAD.l + iw} y1={sy(t)} y2={sy(t)} stroke="var(--data-grid)" stroke-width="1" />
                <text x={PAD.l - 8} y={sy(t)} text-anchor="end" dominant-baseline="central" fill="var(--ink-subtle)" font-family="var(--font-mono)" font-size="12">
                  {yFormat(t)}
                </text>
              </g>
            ))}
            {xTicks.map((t) => (
              <text key={t} x={sx(t)} y={PAD.t + ih + 16} text-anchor="middle" fill="var(--ink-subtle)" font-family="var(--font-mono)" font-size="12">
                {t}
              </text>
            ))}
            <text x={PAD.l + iw / 2} y={height - 4} text-anchor="middle" fill="var(--ink-muted)">{xLabel}</text>
            <text transform={`translate(12 ${PAD.t + ih / 2}) rotate(-90)`} text-anchor="middle" fill="var(--ink-muted)">{yLabel}</text>
            {band && band.length > 1 && (
              <path
                d={`${path(band.map((b) => ({ x: b.x, y: b.hi })))}${band
                  .slice()
                  .reverse()
                  .map((b) => `L${sx(b.x).toFixed(1)},${sy(b.lo).toFixed(1)}`)
                  .join('')}Z`}
                fill="var(--data-1)"
                opacity="0.12"
              />
            )}
            {series.map((s) => {
              const last = s.points[s.points.length - 1];
              if (s.kind === 'raw')
                return (
                  <g key={s.label}>
                    {s.points.map((p, i) => (
                      <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r="3" fill="var(--surface-raised)" stroke="var(--data-6)" stroke-width="1.5" />
                    ))}
                  </g>
                );
              return (
                <g key={s.label}>
                  <path class={s.kind === 'main' ? 'draw' : undefined} pathLength={s.kind === 'main' ? 1 : undefined} d={path(s.points)} fill="none" stroke={s.kind === 'main' ? 'var(--data-1)' : 'var(--data-2)'} stroke-width={s.kind === 'main' ? 3 : 2} stroke-dasharray={s.kind === 'dashed' ? '6 4' : undefined} stroke-linejoin="round" stroke-linecap="round" />
                  {last && (
                    <text x={sx(last.x) + 8} y={sy(last.y)} dominant-baseline="central" fill={s.kind === 'main' ? 'var(--ink)' : 'var(--ink-muted)'} font-weight={s.kind === 'main' ? 500 : 400}>
                      {s.label}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        );
      }}
    </Frame>
  );
}

export function Scatter({ points, height = 200, xLabel, yLabel, xFormat, yFormat, label }: { points: { x: number; y: number }[]; height?: number; xLabel: string; yLabel: string; xFormat: (v: number) => string; yFormat: (v: number) => string; label: string }) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xlo = Math.min(...xs) * 0.9;
  const xhi = Math.max(...xs) * 1.1 || 1;
  const ylo = Math.max(0, Math.min(...ys) - 0.1);
  const yhi = Math.min(1, Math.max(...ys) + 0.1);
  return (
    <Frame height={height} label={label}>
      {(w) => {
        const iw = w - PAD.l - PAD.r;
        const ih = height - PAD.t - PAD.b;
        const sx = (x: number) => PAD.l + ((x - xlo) / (xhi - xlo || 1)) * iw;
        const sy = (y: number) => PAD.t + ih - ((y - ylo) / (yhi - ylo || 1)) * ih;
        return (
          <g font-size="12" font-family="var(--font-mono)">
            {niceTicks(ylo, yhi, 3).map((t) => (
              <g key={t}>
                <line x1={PAD.l} x2={PAD.l + iw} y1={sy(t)} y2={sy(t)} stroke="var(--data-grid)" />
                <text x={PAD.l - 6} y={sy(t)} text-anchor="end" dominant-baseline="central" fill="var(--ink-subtle)">{yFormat(t)}</text>
              </g>
            ))}
            {niceTicks(xlo, xhi, 3).map((t) => (
              <text key={t} x={sx(t)} y={PAD.t + ih + 16} text-anchor="middle" fill="var(--ink-subtle)">{xFormat(t)}</text>
            ))}
            <text x={PAD.l + iw / 2} y={height - 4} text-anchor="middle" fill="var(--ink-muted)" font-family="var(--font-sans)" font-size="12">{xLabel}</text>
            <text transform={`translate(10 ${PAD.t + ih / 2}) rotate(-90)`} text-anchor="middle" fill="var(--ink-muted)" font-family="var(--font-sans)" font-size="12">{yLabel}</text>
            {points.map((p, i) => (
              <circle key={i} cx={sx(p.x)} cy={sy(p.y)} r={i === points.length - 1 ? 5 : 4} fill={i === points.length - 1 ? 'var(--data-1)' : 'var(--data-2)'} opacity={i === points.length - 1 ? 1 : 0.7} />
            ))}
          </g>
        );
      }}
    </Frame>
  );
}

/** Vertical bars with value labels; `highlight` marks the bar the chart is about. */
export function Bars({ bars, height = 200, yMax, format, label, xLabel, highlight }: { bars: { label: string; value: number | null }[]; height?: number; yMax?: number; format: (v: number) => string; label: string; xLabel?: string; highlight?: number }) {
  const max = yMax ?? Math.max(1e-9, ...bars.map((b) => b.value ?? 0));
  return (
    <Frame height={height} label={label}>
      {(w) => {
        const pl = 8;
        const iw = w - pl * 2;
        const ih = height - 28 - 24 - (xLabel ? 16 : 0);
        const bw = iw / bars.length;
        return (
          <g font-family="var(--font-sans)" font-size="12">
            <line x1={pl} x2={pl + iw} y1={24 + ih} y2={24 + ih} stroke="var(--line-strong)" />
            {bars.map((b, i) => {
              const h = b.value === null ? 0 : (b.value / max) * ih;
              const x = pl + i * bw + bw * 0.18;
              const on = highlight === undefined || highlight === i;
              return (
                <g key={i}>
                  <rect x={x} y={24 + ih - h} width={bw * 0.64} height={h} fill={on ? 'var(--data-1)' : 'var(--data-6)'} opacity={on ? 1 : 0.5} rx="2" />
                  <text x={x + bw * 0.32} y={24 + ih - h - 6} text-anchor="middle" fill="var(--ink)" font-family="var(--font-mono)" font-size="12">
                    {b.value === null ? '—' : format(b.value)}
                  </text>
                  <text x={x + bw * 0.32} y={24 + ih + 16} text-anchor="middle" fill="var(--ink-muted)">{b.label}</text>
                </g>
              );
            })}
            {xLabel && <text x={pl + iw / 2} y={height - 2} text-anchor="middle" fill="var(--ink-muted)">{xLabel}</text>}
          </g>
        );
      }}
    </Frame>
  );
}

const seq = (t: number) => (t <= 0 ? 'var(--surface-sunken)' : `var(--seq-${Math.min(5, Math.max(1, Math.ceil(t * 5)))})`);

/** Activity calendar: one cell per day for the last `weeks` weeks. */
export function ActivityHeatmap({ days, weeks = 18, label }: { days: Map<string, number>; weeks?: number; label: string }) {
  const max = Math.max(1, ...days.values());
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1) - ((today.getDay() + 6) % 7 === 6 ? 0 : 0));
  const cells: { x: number; y: number; v: number; d: string }[] = [];
  for (let i = 0; i < weeks * 7; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ x: Math.floor(i / 7), y: (d.getDay() + 6) % 7, v: days.get(key) ?? 0, d: key });
  }
  return (
    <Frame height={7 * 20 + 4} label={label}>
      {(w) => {
        const size = Math.min(20, Math.floor((w - 4) / weeks));
        return (
          <g class="heat">
            {cells.map((c) => (
              <rect key={c.d} x={c.x * size} y={c.y * size} width={size - 2} height={size - 2} rx="2" fill={seq(c.v / max)}>
                <title>{`${c.d}: ${c.v} session${c.v === 1 ? '' : 's'}`}</title>
              </rect>
            ))}
          </g>
        );
      }}
    </Frame>
  );
}

/** One cell per question; colour = share of attempts wrong. */
export function QuestionHeat({ cells, label }: { cells: { id: string; label: string; wrong: number; attempts: number }[]; label: string }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(34px, 1fr))', gap: '4px' }} role="img" aria-label={label}>
      {cells.map((c) => {
        const t = c.attempts ? c.wrong / c.attempts : 0;
        return (
          <span
            key={c.id}
            title={`${c.label}: ${c.attempts ? `${c.wrong} wrong of ${c.attempts}` : 'not attempted'}`}
            style={{
              height: '34px',
              borderRadius: '4px',
              background: c.attempts ? seq(Math.max(0.01, t)) : 'transparent',
              border: c.attempts ? '0' : '1px dashed var(--line)',
              display: 'grid',
              placeItems: 'center',
              fontSize: '12px',
              fontFamily: 'var(--font-mono)',
              color: t > 0.6 ? 'var(--surface)' : 'var(--ink-muted)',
            }}
          >
            {c.label.replace(/^.*#/, '')}
          </span>
        );
      })}
    </div>
  );
}
