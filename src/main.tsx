import { render } from 'preact';
import './styles/tokens.css';
import './styles/app.css';
import { App, updateReady } from './app';
import { routeStore } from './lib/app-state';

render(<App />, document.getElementById('app')!);

/**
 * Service worker: precaches the build for full offline use. A new version waits until the user
 * chooses to update, and the prompt is never shown during a session, so a running session's code
 * is never swapped underneath it.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      const offer = (w: ServiceWorker) =>
        updateReady.set(() => {
          if (routeStore.get().name === 'session') return;
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
        if (reloading) return;
        reloading = true;
        location.reload();
      });
      setInterval(() => void reg.update().catch(() => {}), 60 * 60_000);
    } catch {
      /* offline support unavailable; the app still works online */
    }
  });
}
