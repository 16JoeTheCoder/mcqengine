import { expect, it, vi } from 'vitest';
import { createCloudflareBackend } from '../../src/lib/backend/cloudflare';

const ok = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

it('sends the CSRF header on writes, never on reads, and never caches API responses', async () => {
  const calls: RequestInit[] = [];
  const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => { calls.push(init!); return ok({ accepted: 0, records: [], cursor: null }); });
  const be = createCloudflareBackend({ fetchImpl: fetchImpl as typeof fetch });
  await be.syncPush([], 'A');
  await be.syncPull(null, 500, 'A');
  expect(new Headers(calls[0]!.headers).get('X-DMC')).toBe('1');
  expect(new Headers(calls[1]!.headers).get('X-DMC')).toBeNull();
  for (const c of calls) { expect(c.cache).toBe('no-store'); expect(c.credentials).toBe('same-origin'); }
});

it('names the expected account on every sync request, so a different session is refused by the server', async () => {
  const seen: (string | null)[] = [];
  const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => { seen.push(new Headers(init!.headers).get('X-DMC-Account')); return new Response(JSON.stringify({ error: 'Account changed. Sync stopped.' }), { status: 409 }); });
  const be = createCloudflareBackend({ fetchImpl: fetchImpl as typeof fetch });
  await expect(be.syncPull('7', 10, 'A')).rejects.toThrow('Account changed');
  expect(seen).toEqual(['A']);
});

it('Google sign-in leaves for the Worker route with the return path and school hint; no token reaches the page', async () => {
  const go: string[] = [];
  const be = createCloudflareBackend({ fetchImpl: vi.fn() as never, navigate: (u) => go.push(u) });
  await be.signInGoogle(true, '#/library');
  expect(go).toEqual(['/api/auth/google?return=%23%2Flibrary&school=1']);
});

it('reads the server error message and status, and maps network failures to a plain message', async () => {
  const be = createCloudflareBackend({ fetchImpl: (async () => new Response(JSON.stringify({ error: 'The Library is for school accounts' }), { status: 403 })) as typeof fetch });
  await expect(be.listSets({ search: '', limit: 1, offset: 0 })).rejects.toMatchObject({ message: 'The Library is for school accounts', status: 403 });
  const down = createCloudflareBackend({ fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
  await expect(down.me()).rejects.toThrow('Could not reach DMC');
});
