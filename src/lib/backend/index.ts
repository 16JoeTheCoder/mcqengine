import { selectWorkspace } from '../data/workspace';
import { invalidateSync } from '../sync/sync';
import { finalWrite } from '../tablock';
import { createStore } from '../app-state';
import { createMockBackend } from './mock';
import { createSupabaseBackend } from './supabase';
import type { Account, Backend, LibraryStatus } from './types';

/**
 * Picks the backend from build-time environment values (Vite's VITE_* convention):
 *   VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY  -> Supabase (production)
 *   VITE_BACKEND=mock, or a dev server without them -> the in-browser mock
 *   neither, in a production build              -> no backend: accounts and the Library show "not set up"
 * Only the public anon key is ever read here. A service-role key must never be set in VITE_* values.
 */
function pick(): Backend | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) return createSupabaseBackend(url.replace(/\/+$/, ''), key);
  if (import.meta.env.VITE_BACKEND === 'mock' || import.meta.env.DEV) return createMockBackend();
  return null;
}

export const backend = pick();

export interface AuthState {
  ready: boolean;
  account: Account | null;
  status: LibraryStatus;
}
export const authStore = createStore<AuthState>({ ready: !backend, account: null, status: { member: false, admin: false } });

let identity: string | null | undefined;
let revision = 0;
async function refresh(account: Account | null) {
  const turn = ++revision;
  const next = account?.id ?? null;
  if (identity !== undefined && identity !== next) {
    invalidateSync();
    authStore.set({ ready: false, account: null, status: { member: false, admin: false } });
    // A full document restart discards old screen closures, PDF jobs, and sync callbacks.
    await finalWrite;
    location.replace(`${location.pathname}${location.search}#/`);
    location.reload();
    return;
  }
  if (identity === undefined) {
    identity = next;
    selectWorkspace(next);
  }
  identity = next;
  let status: LibraryStatus = { member: false, admin: false };
  if (account && backend) {
    try {
      status = await backend.status();
    } catch {
      /* offline: keep the Library locked until the server says otherwise */
    }
  }
  if (turn === revision) authStore.set({ ready: true, account, status });
}

/** Called once at start-up. Never blocks the app: it works signed out and offline. */
export async function initAuth() {
  if (!backend) { selectWorkspace(null); return; }
  // Auth callbacks are deferred outside Supabase's auth lock before status makes another request.
  backend.onAuthChange((a) => {
    if (identity !== undefined && (a?.id ?? null) !== identity) {
      invalidateSync();
      authStore.set({ ready: false, account: null, status: { member: false, admin: false } });
    }
    setTimeout(() => void refresh(a), 0);
  });
  await backend.account().then(refresh, () => refresh(null));
}

export type { Account, Backend, LibraryStatus } from './types';
