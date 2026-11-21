import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import { App, updateReady } from './app';
import { routeStore } from './lib/app-state';

render(<App />, document.getElementById('app')!);

/**
 * The app reports its own errors to the Worker (Workers Observability keeps them). At most five
 * per page load; only the message, stack, route name and version: no URLs, ids or content.
 */
if (import.meta.env.PROD && (import.meta.env.VITE_BACKEND ?? 'cloudflare') === 'cloudflare') {
  let sent = 0;
  const report = (kind: string, e: unknown) => {
    if (sent++ >= 5) return;
    const err = e instanceof Error ? e : new Error(String(e));
    void fetch('./api/client-error', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-DMC': '1' },
      body: JSON.stringify({ kind, message: err.message.slice(0, 500), stack: (err.stack ?? '').slice(0, 2000), route: routeStore.get().name, version: __APP_VERSION__ }),
    }).catch(() => {});
  };
  addEventListener('error', (e) => report('error', e.error ?? e.message));
  addEventListener('unhandledrejection', (e) => report('unhandledrejection', e.reason));
}

/**
 * Service worker: precaches the build for full offline use. A new version waits until the user
 * chooses to update, and the prompt is never shown during a session, so a running session's code
 * is never swapped underneath it.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      // Reload only when the user accepted an update, never on the first install.
      let accepted = false;
      const offer = (w: ServiceWorker) =>
        updateReady.set(() => {
          if (routeStore.get().name === 'session') return;
          accepted = true;
          w.postMessage({ type: 'SKIP_WAITING' });
        });
      if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
        });
      });
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloading || !accepted) return;
        reloading = true;
        location.reload();
      });
      setInterval(() => void reg.update().catch(() => {}), 60 * 60_000);
    } catch {
      /* offline support unavailable; the app still works online */
    }
  });
}
