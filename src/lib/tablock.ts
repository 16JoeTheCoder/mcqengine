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
        resolve(release);
        await held;
      })
      .catch(() => resolve(() => {}));
  });
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
