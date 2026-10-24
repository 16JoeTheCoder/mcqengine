import type { ComponentType, JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';

/** Loads a component on first render, so rarely used screens stay out of the initial bundle. */
export function lazy<P extends object>(load: () => Promise<ComponentType<P>>, fallback: JSX.Element | null = null) {
  let cached: ComponentType<P> | null = null;
  return function Lazy(props: P) {
    const [C, setC] = useState<ComponentType<P> | null>(() => cached);
    useEffect(() => {
      if (!cached) void load().then((c) => setC(() => (cached = c)));
    }, []);
    return C ? <C {...props} /> : fallback;
  };
}
