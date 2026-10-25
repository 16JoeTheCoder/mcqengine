import { useEffect, useState } from 'preact/hooks';
import { getSettings, putSettings } from './data/db';
import { DEFAULT_SETTINGS, type Settings } from './types';

/** Minimal observable store. */
export function createStore<T>(initial: T) {
  let value = initial;
  const subs = new Set<(v: T) => void>();
  return {
    get: () => value,
    set(v: T) {
      value = v;
      subs.forEach((s) => s(v));
    },
    sub(fn: (v: T) => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}
export type Store<T> = ReturnType<typeof createStore<T>>;

export function useStore<T>(s: Store<T>): T {
  const [v, setV] = useState(s.get());
  useEffect(() => {
    setV(s.get());
    return s.sub(setV);
  }, [s]);
  return v;
}

// ---------- settings ----------
export const settingsStore = createStore<Settings>(DEFAULT_SETTINGS);
export async function loadSettings() {
  settingsStore.set(await getSettings());
  applyTheme();
}
export async function updateSettings(patch: Partial<Settings>) {
  const next = { ...settingsStore.get(), ...patch };
  settingsStore.set(next);
  applyTheme();
  await putSettings(next);
}
export function applyTheme() {
  const s = settingsStore.get();
  const root = document.documentElement;
  if (s.theme === 'light' || s.theme === 'dark') root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  root.classList.toggle('reduce-motion', s.reduceEffects);
  const dark = s.theme === 'dark' || (s.theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0D0E10' : '#F3F2EE');
}

// ---------- data refresh bus ----------
export const dataVersion = createStore(0);
export const bump = () => dataVersion.set(dataVersion.get() + 1);

// ---------- toasts ----------
export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
}
export const toasts = createStore<Toast[]>([]);
let tid = 0;
export function toast(text: string, action?: Toast['action'], ms = 5000) {
  if (toasts.get().some((x) => x.text === text)) return;
  const t: Toast = { id: ++tid, text, ...(action ? { action } : {}) };
  toasts.set([...toasts.get(), t].slice(-3));
  setTimeout(() => toasts.set(toasts.get().filter((x) => x.id !== t.id)), ms);
}

// ---------- router (hash based: works under any base path on any static host) ----------
export type Route =
  | { name: 'library' }
  | { name: 'pack'; id: string; section?: string }
  | { name: 'session'; id: string }
  | { name: 'results'; id: string }
  | { name: 'settings' };

export function parseRoute(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const q = new URLSearchParams(query);
  if (parts[0] === 'pack' && parts[1]) return { name: 'pack', id: parts[1], ...(q.get('s') ? { section: q.get('s') as string } : {}) };
  if (parts[0] === 'session' && parts[1]) return { name: 'session', id: parts[1] };
  if (parts[0] === 'results' && parts[1]) return { name: 'results', id: parts[1] };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'library' };
}

export const href = {
  library: () => '#/',
  pack: (id: string, section?: string) => `#/pack/${encodeURIComponent(id)}${section ? `?s=${section}` : ''}`,
  session: (id: string) => `#/session/${encodeURIComponent(id)}`,
  results: (id: string) => `#/results/${encodeURIComponent(id)}`,
  settings: () => '#/settings',
};

export const routeStore = createStore<Route>(parseRoute(typeof location !== 'undefined' ? location.hash : ''));

/** Scroll positions per route, restored when returning (e.g. from a session to the pack page). */
const scrolls = new Map<string, number>();
export function navigate(to: string, replace = false) {
  scrolls.set(location.hash || '#/', scrollY);
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  routeStore.set(parseRoute(to));
}
export function savedScroll(hash: string) {
  return scrolls.get(hash);
}
if (typeof window !== 'undefined') {
  addEventListener('popstate', () => routeStore.set(parseRoute(location.hash)));
  addEventListener('hashchange', () => routeStore.set(parseRoute(location.hash)));
}
