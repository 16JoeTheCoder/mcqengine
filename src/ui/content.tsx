import { useEffect, useMemo, useState } from 'preact/hooks';
import { parseMarkup, type Token } from '../lib/format/markup';
import { getImage } from '../lib/data/db';
import type { Figure, Question } from '../lib/types';
import { LETTERS } from '../lib/types';
import { Icon } from './icons';

/** Renders DMC markup with text nodes only (never HTML strings). */
export function Rich({ text }: { text?: string }) {
  const tokens = useMemo(() => (text ? parseMarkup(text) : []), [text]);
  return <>{renderTokens(tokens)}</>;
}

function renderTokens(ts: Token[]) {
  return ts.map((t, i) => {
    switch (t.t) {
      case 'text':
        return t.v;
      case 'br':
        return <br key={i} />;
      case 'sup':
        return <sup key={i}>{renderTokens(t.c)}</sup>;
      case 'sub':
        return <sub key={i}>{renderTokens(t.c)}</sub>;
      case 'b':
        return <strong key={i}>{renderTokens(t.c)}</strong>;
      case 'sqrt':
        return (
          <span key={i} role="math" aria-label={`square root of ${speak(t.c)}`}>
            √<span class="mk-sqrt">{renderTokens(t.c)}</span>
          </span>
        );
      case 'frac':
        return (
          <span key={i} class="mk-frac" role="math" aria-label={`${speak(t.n)} over ${speak(t.d)}`}>
            <span>{renderTokens(t.n)}</span>
            <span>{renderTokens(t.d)}</span>
          </span>
        );
    }
  });
}

/** Spoken form for fractions and roots, so screen readers do not read "1 2" for a half. */
function speak(ts: Token[]): string {
  return ts
    .map((t) => (t.t === 'text' ? t.v : t.t === 'sup' ? ` to the power ${speak(t.c)}` : t.t === 'sub' ? ` sub ${speak(t.c)}` : t.t === 'frac' ? `(${speak(t.n)} over ${speak(t.d)})` : t.t === 'sqrt' ? `square root of ${speak(t.c)}` : t.t === 'b' ? speak(t.c) : ' '))
    .join('')
    .trim();
}

/** Images not yet stored (import preview), looked up before the database. */
export const previewImages = new Map<string, Blob>();

/** Object URL for an image blob or sanitised SVG, revoked on unmount. */
export function useFigureUrl(f?: Figure | { kind: 'image'; imageId: string }): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const key = !f ? '' : f.kind === 'svg' ? f.svg : f.kind === 'image' ? f.imageId : '';
  useEffect(() => {
    let u: string | null = null;
    let live = true;
    setUrl(null);
    if (!f || f.kind === 'needed') return;
    (async () => {
      const blob = f.kind === 'svg' ? new Blob([f.svg], { type: 'image/svg+xml' }) : (previewImages.get(f.imageId) ?? (await getImage(f.imageId))?.blob);
      if (!blob || !live) return;
      u = URL.createObjectURL(blob);
      setUrl(u);
    })();
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [key]);
  return url;
}

/** Figures and question images sit on a light paper panel and are never colour-inverted. */
export function FigureView({ figure, cls = 'fig', onAttach, alt }: { figure?: Figure; cls?: string; onAttach?: () => void; alt?: string }) {
  const url = useFigureUrl(figure);
  if (!figure) return null;
  if (figure.kind === 'needed')
    return (
      <div class="needs-fig">
        <span class="jy-badge jy-badge--warn">Needs figure</span>
        <span class="small muted" style={{ flex: 1 }}>{figure.note ?? 'The diagram for this question has not been attached yet.'}</span>
        {onAttach && (
          <button type="button" class="jy-btn jy-btn--sm" onClick={onAttach}>
            <Icon name="image" size={16} /> Attach figure
          </button>
        )}
      </div>
    );
  return <div class={`paper ${cls}`}>{url ? <img src={url} alt={figure.alt ?? alt ?? 'Figure'} /> : <span class="small">Loading figure…</span>}</div>;
}

export function QuestionImage({ imageId, n }: { imageId: string; n: number }) {
  return <FigureView figure={{ kind: 'image', imageId, alt: `Question ${n} as printed` }} cls="qimage" />;
}

export function OptionBody({ q, i }: { q: Question; i: number }) {
  const o = q.options?.[i];
  if (q.table) {
    const row = q.table.rows[i] ?? [];
    return (
      <span style={{ display: 'grid', gridTemplateColumns: `repeat(${row.length || 1}, minmax(0, 1fr))`, gap: '12px' }}>
        {row.map((c, k) => (
          <span key={k}>
            {q.table?.columns[k] && <span class="sr-only">{q.table.columns[k]}: </span>}
            <Rich text={c} />
          </span>
        ))}
      </span>
    );
  }
  if (!o) return <span class="muted">Option {LETTERS[i]}</span>;
  return (
    <span style={{ display: 'grid', gap: '6px' }}>
      {o.text && (
        <span>
          <Rich text={o.text} />
        </span>
      )}
      {o.figure && <FigureView figure={o.figure} cls="fig" alt={`Option ${LETTERS[i]}`} />}
    </span>
  );
}
