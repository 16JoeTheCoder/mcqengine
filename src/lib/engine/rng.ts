export type Rng = () => number;

/** Deterministic PRNG for tests and reproducible draws. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const cryptoRng: Rng = () => {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return (b[0] ?? 0) / 4294967296;
};

export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}

export function uid(prefix = ''): string {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return prefix + Array.from(b, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 14);
}
