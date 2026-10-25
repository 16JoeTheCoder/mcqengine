import { useEffect, useState } from 'preact/hooks';
import { settingsStore, useStore } from '../lib/app-state';

/**
 * builtbyjosef signature. Logo files are picked up from /brand at build time; the variant is
 * chosen by ground ("-light" files are for light grounds, "-dark" for dark grounds, as in the
 * design standard). Files are shown as-is, never redrawn. Until files exist, a neutral text
 * placeholder renders and swaps automatically once they are added.
 */
const files = import.meta.glob('/brand/*.{svg,png,webp}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

function pick(kind: 'lockup' | 'small', dark: boolean): string | null {
  const names = Object.keys(files);
  const ground = dark ? 'dark' : 'light';
  const match = (re: RegExp) => names.find((n) => re.test(n.toLowerCase()));
  const found =
    kind === 'lockup'
      ? match(new RegExp(`lockup-${ground}`)) ?? match(/lockup/)
      : match(new RegExp(`(primary|small)-${ground}`)) ?? (dark ? match(/mono-paper/) : match(/small|mono-ink/)) ?? null;
  return found ? (files[found] ?? null) : null;
}

export function useDark(): boolean {
  const s = useStore(settingsStore);
  const [sys, setSys] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const m = matchMedia('(prefers-color-scheme: dark)');
    const h = () => setSys(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);
  return s.theme === 'dark' || (s.theme !== 'light' && sys);
}

export function Signature({ height = 40, kind = 'lockup' }: { height?: number; kind?: 'lockup' | 'small' }) {
  const dark = useDark();
  const src = pick(kind, dark) ?? (kind === 'small' ? pick('lockup', dark) : null);
  if (!src)
    return (
      <span style={{ fontSize: `${Math.max(14, height * 0.45)}px`, letterSpacing: '-0.02em', lineHeight: 1 }} aria-label="builtbyjosef">
        <span style={{ fontWeight: 300 }}>builtby</span>
        <span style={{ fontWeight: 700 }}>josef</span>
      </span>
    );
  // Intrinsic ratios of the standard's files (lockup 480 x 128, tab 72 x 128) reserve space before load.
  const ratio = /lockup/.test(src) ? 480 / 128 : 72 / 128;
  return <img src={src} alt="builtbyjosef" height={height} width={Math.round(height * ratio)} style={{ height: `${height}px`, width: 'auto', maxWidth: '100%', objectFit: 'contain', objectPosition: 'left center' }} />;
}

/** DMC mark: a Tab (72 x 128, corner 10, orange cap) holding three answer bars, one chosen. */
export function DmcMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 72 128" height={size} width={(size * 72) / 128} aria-hidden="true">
      <path fill="var(--ink)" d="M0 10A10 10 0 0 1 10 0h52a10 10 0 0 1 10 10v108a10 10 0 0 1-10 10H10A10 10 0 0 1 0 118Z" />
      <path fill="var(--brand-orange)" d="M0 14v-4A10 10 0 0 1 10 0h52a10 10 0 0 1 10 10v4Z" />
      <rect x="14" y="40" width="44" height="12" rx="3" fill="var(--surface)" opacity="0.45" />
      <rect x="14" y="62" width="44" height="12" rx="3" fill="var(--surface)" />
      <rect x="14" y="84" width="44" height="12" rx="3" fill="var(--surface)" opacity="0.45" />
    </svg>
  );
}
