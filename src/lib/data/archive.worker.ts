import { zipSync, type Zippable } from 'fflate';

self.onmessage = (event: MessageEvent<Zippable>) => {
  try {
    const data = zipSync(event.data, { level: 6 });
    self.postMessage({ data }, { transfer: [data.buffer] });
  } catch {
    self.postMessage({ error: 'Could not create archive. Export fewer packs and try again.' });
  }
};
