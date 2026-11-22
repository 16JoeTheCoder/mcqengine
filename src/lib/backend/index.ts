import { selectWorkspace } from '../data/workspace';
import { invalidateSync } from '../sync/sync';
import { finalWrite } from '../tablock';
import { createStore } from '../app-state';
import { createCloudflareBackend } from './cloudflare';
import { createMockBackend } from './mock';
import type { Account, Backend, LibraryStatus } from './types';

/**
 * Picks the backend at build time (VITE_BACKEND):
 *   cloudflare (default in a production build) -> the DMC Worker on the same origin (/api/*)
 *   mock (default on the dev server)           -> the in-browser mock with the same rules
 *   none                                       -> no accounts: they show "not set up"
 * No secret is ever read here; the Worker holds them all.
 */
function pick(): Backend | null {
  const choice = (import.meta.env.VITE_BACKEND as string | undefined) ?? (import.meta.env.DEV ? 'mock' : 'cloudflare');
  if (choice === 'none') return null;
  if (choice === 'mock') return createMockBackend();
  return createCloudflareBackend();
}

export const backend = pick();

export interface AuthState {
  ready: boolean;
  account: Account | null;
  status: LibraryStatus;
  /** Sync on by default for school accounts (the server's verdict); Settings can override it. */
  syncDefault: boolean;
}
export const authStore = createStore<AuthState>({ ready: !backend, account: null, status: { member: false, admin: false }, syncDefault: false });

let identity: string | null | undefined;
let revision = 0;
async function refresh(account: Account | null) {
  const turn = ++revision;
  const next = account?.id ?? null;
  if (identity !== undefined && identity !== next) {
    invalidateSync();
    authStore.set({ ready: false, account: null, status: { member: false, admin: false }, syncDefault: false });
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
  let syncDefault = false;
  if (account && backend) {
    try {
      const m = await backend.me();
      // The server's copy carries fields the session cache may lack (the profile handle).
      if (m.account?.id === account.id) account = { ...account, ...m.account };
      status = m.status;
      syncDefault = m.syncDefault;
    } catch {
      /* offline: keep the Library locked until the server says otherwise */
    }
  }
  if (turn === revision) authStore.set({ ready: true, account, status, syncDefault });
}

/** Called once at start-up. Never blocks the app: it works signed out and offline. */
export async function initAuth() {
  if (!backend) { selectWorkspace(null); return; }
  backend.onAuthChange((a) => {
    if (identity !== undefined && (a?.id ?? null) !== identity) {
      invalidateSync();
      authStore.set({ ready: false, account: null, status: { member: false, admin: false }, syncDefault: false });
    }
    setTimeout(() => void refresh(a), 0);
  });
  // Offline at start-up: stay signed out locally and keep the app working.
  await backend.account().then(refresh, () => refresh(null));
  // Google sign-in returns to #/?signin=failed when the server refused it.
  if (/[?&]signin=failed/.test(location.hash)) {
    history.replaceState(null, '', `${location.pathname}${location.search}${location.hash.replace(/[?&]signin=failed/, '')}`);
    dispatchEvent(new CustomEvent('dmc:signin-failed'));
  }
}

export type { Account, Backend, LibraryStatus } from './types';
