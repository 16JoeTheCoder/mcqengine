/**
 * One active session across tabs. Uses the Web Locks API (held for as long as the session screen
 * is open); a BroadcastChannel tells other tabs to refresh after data changes.
 */
type Release = () => void;

export async function acquireSessionLock(): Promise<Release | null> {
  if (!('locks' in navigator)) return () => {};
  return new Promise((resolve) => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    navigator.locks
      .request('dmc-active-session', { ifAvailable: true }, async (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        ownLock = true;
        resolve(release);
        await held;
        ownLock = false;
      })
      .catch(() => resolve(() => {}));
  });
}

let ownLock = false;

/** True when another tab is running a session (this tab's own lock does not count). */
export async function sessionLockHeld(): Promise<boolean> {
  try {
    if (ownLock || !('locks' in navigator) || !navigator.locks.query) return false;
    const q = await navigator.locks.query();
    return !!q.held?.some((l) => l.name === 'dmc-active-session');
  } catch {
    return false;
  }
}

/** The session screen's last write; the lock is released only after it lands. */
export let finalWrite: Promise<unknown> = Promise.resolve();
export function setFinalWrite(p: Promise<unknown>) {
  finalWrite = p;
}

const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dmc') : null;
export function broadcastChange() {
  channel?.postMessage({ type: 'changed' });
}
export function onRemoteChange(fn: () => void) {
  if (!channel) return () => {};
  const h = (e: MessageEvent) => e.data?.type === 'changed' && fn();
  channel.addEventListener('message', h);
  return () => channel.removeEventListener('message', h);
}
