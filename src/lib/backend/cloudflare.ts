import { BackendError, type Account, type Backend, type Me, type SyncRecord } from './types';

/**
 * The DMC Worker on Cloudflare, same origin (`/api/*`). Auth is an HttpOnly session cookie the
 * page never sees; every state-changing request carries `X-DMC: 1`, which a cross-site form
 * cannot send. `fetchImpl` and `base` are injectable so the tests run this client against the
 * real Worker in Miniflare.
 */
export function createCloudflareBackend(opts: { base?: string; fetchImpl?: typeof fetch; navigate?: (url: string) => void } = {}): Backend {
  const base = opts.base ?? '';
  const f = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const listeners = new Set<(a: Account | null) => void>();
  let cached: Promise<Me> | null = null;

  async function call<T>(path: string, init: RequestInit & { json?: unknown; account?: string } = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.method && init.method !== 'GET') headers.set('X-DMC', '1');
    if (init.json !== undefined) headers.set('Content-Type', 'application/json');
    if (init.account) headers.set('X-DMC-Account', init.account);
    let r: Response;
    try {
      r = await f(`${base}/api${path}`, { ...init, headers, credentials: 'same-origin', cache: 'no-store', ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}) });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      throw new BackendError('Could not reach DMC. Check your connection.', 0);
    }
    if (r.status === 204) return undefined as T;
    let data: unknown = null;
    try { data = await r.json(); } catch { /* non-JSON error body */ }
    if (!r.ok) {
      const retry = Number(r.headers.get('retry-after'));
      throw new BackendError((data as { error?: string } | null)?.error ?? `Request failed (${r.status})`, r.status, Number.isFinite(retry) && retry > 0 ? retry : undefined);
    }
    return data as T;
  }
  const meNow = () => (cached ??= call<Me>('/me').catch((e) => { cached = null; throw e; }));
  const changed = async () => {
    cached = null;
    const a = (await meNow().catch(() => null))?.account ?? null;
    listeners.forEach((fn) => fn(a));
  };

  return {
    kind: 'cloudflare',
    me: meNow,
    account: async () => (await meNow()).account,
    onAuthChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async signInGoogle(school, returnTo = location.hash || '#/') {
      const q = new URLSearchParams({ return: returnTo, ...(school ? { school: '1' } : {}) });
      (opts.navigate ?? ((u) => location.assign(u)))(`${base}/api/auth/google?${q}`);
    },
    async signInDev(email) {
      await call('/auth/dev', { method: 'POST', json: { email } });
      await changed();
    },
    async signOut() {
      await call('/auth/logout', { method: 'POST' });
      await changed();
    },
    status: async () => (await meNow()).status,
    async updateName(name) {
      const r = await call<{ name: string }>('/me', { method: 'PATCH', json: { name } });
      await changed();
      return r.name;
    },

    async listSets({ search, limit, offset }) {
      const q = new URLSearchParams({ search, limit: String(limit), offset: String(offset) });
      return (await call<{ sets: import('./types').LibrarySet[] }>(`/sets?${q}`)).sets;
    },
    getSet: (id, version) => call(`/sets/${encodeURIComponent(id)}${version ? `/versions/${version}` : ''}`),
    async lookupPapers(keys) {
      if (!keys.length) return [];
      return (await call<{ papers: import('./types').RegistryPaper[] }>('/papers/lookup', { method: 'POST', json: { keys } })).papers;
    },
    async checkBlobs(hashes) {
      if (!hashes.length) return [];
      return (await call<{ missing: string[] }>('/blobs/check', { method: 'POST', json: { hashes } })).missing;
    },
    async uploadBlob(hash, blob, type, onProgress, signal) {
      // XMLHttpRequest for upload progress; fetch has none. Tests inject fetch instead.
      if (opts.fetchImpl || typeof XMLHttpRequest === 'undefined') {
        await call(`/blobs/${hash}`, { method: 'PUT', body: blob, headers: { 'Content-Type': type }, signal });
        onProgress(blob.size);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('PUT', `${base}/api/blobs/${hash}`);
        x.setRequestHeader('Content-Type', type);
        x.setRequestHeader('X-DMC', '1');
        x.upload.onprogress = (e) => onProgress(e.loaded);
        x.onload = () => {
          if (x.status < 300) return resolve();
          let msg = `Upload refused (${x.status})`;
          try { msg = (JSON.parse(x.responseText) as { error?: string }).error ?? msg; } catch { /* keep status */ }
          reject(new BackendError(msg, x.status));
        };
        x.onerror = () => reject(new BackendError('Network error during upload', 0));
        x.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
        signal.addEventListener('abort', () => x.abort(), { once: true });
        x.send(blob);
      });
      onProgress(blob.size);
    },
    async getBlob(hash, signal) {
      const r = await f(`${base}/api/blob/${hash}`, { credentials: 'same-origin', signal }).catch((e: Error) => {
        if (e.name === 'AbortError') throw e;
        throw new BackendError('Could not reach DMC. Check your connection.', 0);
      });
      if (r.status === 404) return null;
      if (!r.ok) throw new BackendError(r.status === 403 ? 'The Library is for school accounts' : `Download failed (${r.status})`, r.status);
      return r.blob();
    },
    blobUrl: async (hash) => `${base}/api/blob/${hash}`,
    publishVersion: (setId, b, manifest) => call(`/sets/${setId}/versions`, { method: 'POST', json: { base: b, manifest } }),
    async updateSet(id, patch) { await call(`/sets/${id}`, { method: 'PATCH', json: patch }); },
    async deleteSet(id) { await call(`/sets/${id}`, { method: 'DELETE' }); },
    async star(id, on) { await call(`/sets/${id}/star`, { method: 'PUT', json: { on } }); },
    async report(id, reason) { await call(`/sets/${id}/report`, { method: 'POST', json: { reason } }); },

    async syncPush(records, expectedAccount) {
      return (await call<{ accepted: number }>('/sync/push', { method: 'POST', json: { records: records.map(({ server_revision: _s, ...r }) => ({ ...r, base_updated_at: r.base_updated_at ?? 0 })) }, ...(expectedAccount ? { account: expectedAccount } : {}) })).accepted;
    },
    async syncPull(cursor, limit, expectedAccount) {
      const q = new URLSearchParams({ limit: String(limit), ...(cursor && /^\d+$/.test(cursor) ? { after: cursor } : {}) });
      return call<{ records: SyncRecord[]; cursor: string | null }>(`/sync/pull?${q}`, expectedAccount ? { account: expectedAccount } : {});
    },

    async putBackup(blob, onProgress) {
      await call('/me/backup', { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/zip' } });
      onProgress(blob.size);
    },
    async getBackup() {
      const r = await f(`${base}/api/me/backup`, { credentials: 'same-origin', cache: 'no-store' });
      return r.ok ? r.blob() : null;
    },

    admin: (path, init = {}) => call(`/admin/${path}`, { method: init.method ?? 'GET', ...(init.body !== undefined ? { json: init.body } : {}) }),
  };
}
