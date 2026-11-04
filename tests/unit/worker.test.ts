// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { AiBudget, DEFAULT_MODEL, PROVIDER_URL, providerBody, validateInput, validateOutput, type Env, type KvStorage } from '../../worker/index';

class MemoryStorage implements KvStorage {
  rows = new Map<string, unknown>();
  chain = Promise.resolve();
  async get<T>(key: string) { return structuredClone(this.rows.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.rows.set(key, structuredClone(value)); }
  transaction<T>(fn: (tx: KvStorage) => Promise<T>): Promise<T> {
    const next = this.chain.then(() => fn(this)); this.chain = next.then(() => {}, () => {}); return next;
  }
}
const input = { pages: [{ page: 2, role: 'question' as const, text: '1 What is 2+2? A 3 B 4' }], hasMarkScheme: false };
const output = { questions: [{ n: 1, page: 2, stem: 'What is 2+2?', options: ['3', '4'], answer: 'B' }], warnings: [] };
function env(patch: Partial<Env> = {}): Env {
  return { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_ANON_KEY: 'public-key', NVIDIA_API_KEY: 'private-provider-key', AI_MAX_RETRIES: '0', AI_BUDGET: { idFromName: (s) => s, get: () => ({ fetch: async () => new Response('{}') }) }, ...patch };
}
const request = (body: unknown = input) => new Request('https://mcq.example.com/api/ai/extract', { method: 'POST', headers: { Authorization: 'Bearer valid.jwt.token', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const internal = () => new Request('https://budget.internal/extract', { method: 'POST', headers: { 'X-Account-ID': 'account-a', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
const completed = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('authenticated NVIDIA Worker', () => {
  it('rejects unauthenticated requests without calling a provider', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const response = await worker.fetch(new Request('https://mcq.example.com/api/ai/extract', { method: 'POST' }), env());
    expect(response.status).toBe(401); expect(fetch).not.toHaveBeenCalled();
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
  it('verifies the bearer server-side, rejects expired and unverified identities', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify({ id: 'a' })));
    vi.stubGlobal('fetch', fetch);
    expect((await worker.fetch(request(), env())).status).toBe(401);
    expect((await worker.fetch(request(), env())).status).toBe(403);
    expect(fetch.mock.calls[0]![0]).toBe('https://test.supabase.co/auth/v1/user');
  });
  it('does not disclose secrets in config or provider error messages', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'a', email_confirmed_at: '2026-01-01' })));
    vi.stubGlobal('fetch', fetch);
    const config = await worker.fetch(new Request('https://mcq.example.com/api/ai/config', { headers: { Authorization: 'Bearer valid.jwt.token' } }), env());
    expect(await config.json()).toEqual({ configured: true, model: DEFAULT_MODEL, maxPagesPerBatch: 4, maxPayloadBytes: 4_000_000, maxTextChars: 60_000, maxImageBytes: 1_000_000 });
    fetch.mockResolvedValueOnce(new Response('private-provider-key confidential-payload', { status: 401 }));
    const result = await new AiBudget({ storage: new MemoryStorage() }, env()).fetch(internal());
    expect(result.status).toBe(502); expect(await result.text()).not.toContain('private-provider-key');
  });
  it('only accepts bounded inline images, expected fields, and matching mark schemes', async () => {
    expect(() => validateInput({ ...input, endpoint: 'https://evil.test' }, env())).toThrow();
    expect(() => validateInput({ ...input, pages: [{ ...input.pages[0], image: 'https://evil.test/x.png' }] }, env())).toThrow();
    expect(() => validateInput({ ...input, hasMarkScheme: true }, env())).toThrow();
    expect(() => validateInput({ ...input, pages: Array.from({ length: 5 }, (_, i) => ({ page: i + 1, role: 'question', text: 'x' })) }, env())).toThrow();
    expect(() => validateInput({ ...input, pages: [{ ...input.pages[0], text: 'x'.repeat(60_001) }] }, env())).toThrow();
    expect(() => validateInput({ ...input, pages: [input.pages[0], input.pages[0]] }, env())).toThrow();
  });
  it('rejects cross-site browser calls and excessive streamed payloads', async () => {
    expect((await worker.fetch(new Request(request(), { headers: { Origin: 'https://evil.test' } }), env())).status).toBe(403);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'a', email_confirmed_at: 'date' }))));
    const r = await worker.fetch(request({ pages: ['x'.repeat(4_000_001)] }), env());
    expect(r.status).toBe(413);
  });
  it('sends only server-controlled model and endpoint, then clears unsupported answer guesses', async () => {
    const fetch = vi.fn().mockResolvedValue(completed()); vi.stubGlobal('fetch', fetch);
    const r = await new AiBudget({ storage: new MemoryStorage() }, env()).fetch(internal());
    expect(r.status).toBe(200); expect((await r.json()).questions[0].answer).toBeNull();
    expect(fetch.mock.calls[0]![0]).toBe(PROVIDER_URL);
    expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('Bearer private-provider-key');
    expect(JSON.stringify(providerBody(input, env()))).not.toContain('private-provider-key');
  });
  it('flags missing numbers and rejects duplicates, invalid indices, extra fields and truncated output', async () => {
    expect(validateOutput(output, input).questions[0]!.answer).toBeNull();
    expect(() => validateOutput({ questions: [...output.questions, output.questions[0]] }, input)).toThrow(/duplicate/);
    expect(() => validateOutput({ questions: [{ ...output.questions[0], answer: 'E' }] }, input)).toThrow();
    expect(() => validateOutput({ questions: [{ ...output.questions[0], html: '<script>' }] }, input)).toThrow();
    expect(() => validateOutput({ questions: [{ ...output.questions[0], page: 99 }] }, input)).toThrow();
    const gap = validateOutput({ questions: [output.questions[0], { ...output.questions[0], n: 3 }] }, input);
    expect(gap.warnings).toContain('Missing question numbers between 1 and 3.');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), { headers: { 'Content-Type': 'application/json' } })));
    expect((await new AiBudget({ storage: new MemoryStorage() }, env()).fetch(internal())).status).toBe(502);
  });
});

describe('persistent shared AI budget', () => {
  it('coordinates requests across object instances and concurrent users', async () => {
    const storage = new MemoryStorage(); const e = env({ AI_SHARED_RPM: '2', AI_CONCURRENCY: '8' });
    const a = new AiBudget({ storage }, e); const b = new AiBudget({ storage }, e);
    const results = await Promise.allSettled([a.reserve('a', '1', 100_000), b.reserve('b', '2', 100_000), a.reserve('c', '3', 100_000)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    await expect(b.reserve('b', '4', 161_000)).resolves.toBeUndefined();
  });
  it('limits global concurrency, releases failed leases, and expires crashed leases', async () => {
    const storage = new MemoryStorage(); const b = new AiBudget({ storage }, env({ AI_CONCURRENCY: '1' }));
    await b.reserve('a', '1', 100_000); await expect(b.reserve('b', '2', 100_000)).rejects.toThrow(/busy/);
    await b.release('1'); await b.reserve('b', '2', 100_001);
    await expect(b.reserve('c', '3', 151_000)).resolves.toBeUndefined();
  });
  it('charges failed requests and retries against the same shared and per-user budget', async () => {
    const b = new AiBudget({ storage: new MemoryStorage() }, env({ AI_USER_DAILY_REQUESTS: '1' }));
    await b.reserve('a', '1', 100_000); await b.release('1');
    await expect(b.reserve('a', '2', 200_000)).rejects.toThrow(/Daily/);
    await expect(b.reserve('a', '3', 86_500_000)).resolves.toBeUndefined();
  });
  it('honors long Retry-After without looping, and releases the slot', async () => {
    const storage = new MemoryStorage(); const b = new AiBudget({ storage }, env({ AI_MAX_RETRIES: '2' }));
    const fetch = vi.fn().mockResolvedValue(new Response('do not relay', { status: 429, headers: { 'Retry-After': '60' } })); vi.stubGlobal('fetch', fetch);
    const r = await b.fetch(internal()); expect(r.status).toBe(503); expect(r.headers.get('Retry-After')).toBe('60'); expect(fetch).toHaveBeenCalledTimes(1);
    expect((await storage.get<{ leases: object }>('budget'))!.leases).toEqual({});
  });
  it('retries transient failures once and counts every provider request', async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage(); const b = new AiBudget({ storage }, env({ AI_MAX_RETRIES: '1' }));
    const fetch = vi.fn().mockResolvedValueOnce(new Response('', { status: 503, headers: { 'Retry-After': '1' } })).mockResolvedValueOnce(completed()); vi.stubGlobal('fetch', fetch);
    const pending = b.fetch(internal()); await vi.advanceTimersByTimeAsync(1100);
    expect((await pending).status).toBe(200); expect(fetch).toHaveBeenCalledTimes(2);
    expect((await storage.get<{ requests: number[] }>('budget'))!.requests).toHaveLength(2);
  });
  it('cancels before provider call without spending quota', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch); const controller = new AbortController(); controller.abort();
    const req = new Request(internal(), { signal: controller.signal });
    expect((await new AiBudget({ storage: new MemoryStorage() }, env()).fetch(req)).status).toBe(499); expect(fetch).not.toHaveBeenCalled();
  });
});
