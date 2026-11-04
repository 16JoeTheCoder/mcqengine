import type { Zippable } from 'fflate';
import { MAX_ZIP_BYTES, ZIP_LIMITS } from './files';

/** CPU-heavy archive compression runs in a dedicated bundled worker in browsers. */
export async function archive(files: Record<string, Uint8Array>, stored: Record<string, Uint8Array> = {}): Promise<Uint8Array> {
  const entries = Object.entries({ ...files, ...stored });
  if (entries.length > ZIP_LIMITS.entries || entries.some(([, v]) => v.byteLength > ZIP_LIMITS.entryBytes) || entries.reduce((n, [, v]) => n + v.byteLength, 0) > ZIP_LIMITS.totalBytes) {
    throw new Error('The archive exceeds the file count or size limit. Export fewer packs.');
  }
  const input: Zippable = { ...files, ...Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, [v, { level: 0 }]])) };
  let out: Uint8Array;
  if (typeof Worker === 'function') {
    out = await new Promise<Uint8Array>((resolve, reject) => {
      const worker = new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' });
      const timeout = setTimeout(() => { worker.terminate(); reject(new Error('Archive creation timed out. Export fewer packs.')); }, 120_000);
      const done = () => { clearTimeout(timeout); worker.terminate(); };
      worker.onmessage = (e: MessageEvent<{ data?: Uint8Array; error?: string }>) => {
        done();
        if (e.data.data) resolve(e.data.data);
        else reject(new Error(e.data.error ?? 'Could not create archive'));
      };
      worker.onerror = () => { done(); reject(new Error('Archive worker failed. Reload and try again.')); };
      worker.postMessage(input);
    });
  } else {
    // CLI and test environments have no browser Worker. The same limits still apply.
    const { zipSync } = await import('fflate');
    out = zipSync(input, { level: 6 });
  }
  if (out.byteLength > MAX_ZIP_BYTES) throw new Error('The compressed archive exceeds 100 MB. Export fewer packs.');
  return out;
}
