import { AI_LIMITS, type AiBatch, type AiPage } from '../shared/ai-protocol';
import { AI_TASKS, PROMPTS, REPAIR, type AiTask, type TaskInput } from '../shared/prompts';
import { validateDoc } from '../src/lib/format/validate';
import { need, needAdmin } from './auth';
import { ApiError, int, isObj, json, obj, readJson, type Obj } from './http';
import type { DurableObjectStorage, Env, ExecutionContext } from './types';

/**
 * AI import through NVIDIA, the only provider caller. The key is the Worker secret
 * NVIDIA_API_KEY; it never reaches D1 or the browser. Every request goes through one named
 * Durable Object, which queues (rather than rejects) beyond the shared per-minute cap and tells
 * the caller its queue position, keeps per-account daily allowances, and checks every reply
 * against the task's rules and the app's pack validator, retrying once with the exact problems.
 */
export const PROVIDER_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
export const DEFAULT_MODEL = 'nvidia/nemotron-3.5-bolt-e4b';
const bounded = (v: string | undefined, fallback: number, min: number, max: number) => Math.min(max, Math.max(min, v?.trim() && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : fallback));
export const model = (env: Env) => env.NVIDIA_MODEL?.trim() || DEFAULT_MODEL;
export const aiSettings = (env: Env) => ({
  rpm: bounded(env.AI_SHARED_RPM, 38, 1, 39),
  daily: bounded(env.AI_USER_DAILY_REQUESTS, 100, 1, 5000),
  concurrency: bounded(env.AI_CONCURRENCY, 4, 1, 16),
  maxPages: bounded(env.AI_MAX_PAGES, AI_LIMITS.pagesPerBatch, 1, AI_LIMITS.pagesPerBatch),
  timeoutMs: bounded(env.AI_TIMEOUT_MS, 45_000, 1000, 120_000),
  queueMax: bounded(env.AI_QUEUE_MAX, 60, 1, 500),
  maxWaitMs: 10 * 60_000,
});

const string = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
function pages(value: unknown, env: Env, roles: AiPage['role'][]): AiPage[] {
  const max = aiSettings(env).maxPages;
  if (!Array.isArray(value) || !value.length || value.length > max) throw new ApiError(`Choose 1 to ${max} pages for one request`);
  const seen = new Set<string>();
  return value.map((p0) => {
    const p = obj(p0, ['page', 'role', 'text', 'image'], 'source page');
    if (!Number.isInteger(p.page) || Number(p.page) < 1 || Number(p.page) > 500 || !roles.includes(p.role as AiPage['role'])) throw new ApiError('Invalid source page');
    const id = `${p.role}:${p.page}`;
    if (seen.has(id)) throw new ApiError('Duplicate source page');
    seen.add(id);
    if (p.text !== undefined && !string(p.text, AI_LIMITS.pageTextChars)) throw new ApiError('Page text exceeds the limit');
    if (p.image !== undefined && (!string(p.image, AI_LIMITS.imageDataUrlChars) || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image))) throw new ApiError('Use bounded JPEG, PNG or WebP page images, not PDFs or links');
    if (!p.text && !p.image) throw new ApiError('Page has no text or image');
    return p as unknown as AiPage;
  });
}

/** Checks a task's inputs at the boundary. The prompt is never part of the request. */
export function validateTask(body: unknown, env: Env): { task: AiTask; input: TaskInput[AiTask] } {
  const b = obj(body, ['task', 'input']);
  if (!AI_TASKS.includes(b.task as AiTask)) throw new ApiError(`Unknown AI task. Use one of: ${AI_TASKS.join(', ')}`);
  const task = b.task as AiTask;
  if (!isObj(b.input)) throw new ApiError('Missing task input');
  if (task === 'extract') {
    const i = obj(b.input, ['pages', 'hasMarkScheme'], 'input');
    if (typeof i.hasMarkScheme !== 'boolean') throw new ApiError('hasMarkScheme must be true or false');
    const ps = pages(i.pages, env, ['question', 'markscheme']);
    if (!ps.some((p) => p.role === 'question') || i.hasMarkScheme !== ps.some((p) => p.role === 'markscheme')) throw new ApiError('Mark-scheme selection does not match the supplied pages');
    return { task, input: { pages: ps, hasMarkScheme: i.hasMarkScheme } };
  }
  if (task === 'key') {
    const i = obj(b.input, ['pages', 'questionCount', 'optionCount'], 'input');
    return { task, input: { pages: pages(i.pages, env, ['markscheme']), questionCount: int(i.questionCount, 'questionCount', 1, 200), optionCount: int(i.optionCount, 'optionCount', 2, 5) } };
  }
  const i = obj(b.input, ['image', 'n', 'context'], 'input');
  if (!string(i.image, AI_LIMITS.imageDataUrlChars) || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(i.image)) throw new ApiError('Send the figure as a bounded image');
  if (i.context !== undefined && !string(i.context, 2000)) throw new ApiError('Context is too long');
  return { task, input: { image: i.image, n: int(i.n, 'n', 1, 200), ...(i.context ? { context: i.context as string } : {}) } };
}

/** The extraction reply must also pass the app's own pack validator, not only the AI contract. */
function packCheck(batch: AiBatch): void {
  const qs = batch.questions;
  const doc = { format: 'dmc-pack/1', papers: [{ id: 'ai-check', title: 'AI check', questionCount: Math.max(...qs.map((q) => q.n)), optionCount: qs[0]!.options.length, questions: qs.map((q) => ({ n: q.n, page: q.page, stem: q.stem, options: q.options, answer: q.answer, ...(q.table ? { table: q.table } : {}), ...(q.explanation ? { explanation: q.explanation } : {}) })) }] };
  const r = validateDoc(doc);
  if (r.errors.length) throw new Error(r.errors.slice(0, 20).map((e) => `${e.path.replace('papers[0].', '')}: ${e.message}`).join('\n'));
}

export function checkOutput(task: AiTask, raw: unknown, input: TaskInput[AiTask]): unknown {
  const out = (PROMPTS[task].check as (o: unknown, i: unknown) => unknown)(raw, input);
  if (task === 'extract') packCheck(out as AiBatch);
  return out;
}

export function providerBody(env: Env, system: string, content: unknown[]) {
  return { model: model(env), messages: [{ role: 'system', content: system }, { role: 'user', content }], temperature: 0, max_tokens: 8192, stream: false };
}

// ---------- routes ----------
/** GET /api/ai/config */
export async function aiConfig(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await need(req, env, ctx);
  const s = aiSettings(env);
  return json({ configured: !!env.NVIDIA_API_KEY, model: model(env), maxPagesPerBatch: s.maxPages, maxPayloadBytes: AI_LIMITS.payloadBytes, maxTextChars: AI_LIMITS.pageTextChars, maxImageBytes: AI_LIMITS.imageBytes, tasks: AI_TASKS.map((t) => ({ task: t, prompt: PROMPTS[t].id, version: PROMPTS[t].version })) });
}

const budget = (env: Env) => env.AI_BUDGET.get(env.AI_BUDGET.idFromName('nvidia-shared-budget'));

/** POST /api/ai/run { task, input } -> NDJSON stream: {"type":"queued","position":n} … {"type":"result","data":…} */
export async function aiRun(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const c = await need(req, env, ctx);
  if (!c.user.email_verified) throw new ApiError('Verify your email before using AI import', 403);
  if (!env.NVIDIA_API_KEY) throw new ApiError('AI import is not configured. Manual import is available.', 503);
  const body = validateTask(await readJson(req, AI_LIMITS.payloadBytes), env);
  return budget(env).fetch(new Request('https://budget.internal/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Account-ID': c.user.id }, body: JSON.stringify(body), signal: req.signal }));
}

export async function aiStatus(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  return budget(env).fetch(new Request('https://budget.internal/status'));
}
export async function aiTest(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  await needAdmin(req, env, ctx);
  if (!env.NVIDIA_API_KEY) throw new ApiError('NVIDIA_API_KEY is not set on this Worker', 503);
  return budget(env).fetch(new Request('https://budget.internal/test', { method: 'POST' }));
}

// ---------- the shared budget and queue ----------
interface Waiter { resolve: () => void; reject: (e: Error) => void; at: number; onPosition: (n: number) => void }

/** One named object per environment serializes every provider call across all Worker isolates. */
export class AiBudget {
  private window: number[] = [];
  private active = 0;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private storage: DurableObjectStorage;
  private env: Env;
  constructor(state: { storage: DurableObjectStorage }, env: Env) {
    this.storage = state.storage;
    this.env = env;
  }

  private settings() { return aiSettings(this.env); }
  private prune(now: number) { this.window = this.window.filter((t) => t > now - 60_000); }

  /** Waits for a slot under the per-minute cap and the concurrency cap, in arrival order. */
  async acquire(onPosition: (n: number) => void, signal?: AbortSignal): Promise<void> {
    const s = this.settings();
    const now = Date.now();
    this.prune(now);
    if (!this.queue.length && this.window.length < s.rpm && this.active < s.concurrency) {
      this.window.push(now);
      this.active++;
      return;
    }
    if (this.queue.length >= s.queueMax) throw new ApiError('The AI queue is full. Try again in a few minutes; manual import is available.', 429, 60);
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { resolve, reject, at: now, onPosition };
      this.queue.push(w);
      onPosition(this.queue.length);
      signal?.addEventListener('abort', () => { this.queue = this.queue.filter((x) => x !== w); this.announce(); reject(new ApiError('Import cancelled', 499)); }, { once: true });
      this.drain();
    });
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    this.drain();
  }

  private announce() { this.queue.forEach((w, i) => w.onPosition(i + 1)); }

  private drain() {
    const s = this.settings();
    const now = Date.now();
    this.prune(now);
    for (const w of this.queue.filter((x) => now - x.at > s.maxWaitMs)) w.reject(new ApiError('The AI queue took too long. Try again later; manual import is available.', 503, 60));
    this.queue = this.queue.filter((x) => now - x.at <= s.maxWaitMs);
    let moved = false;
    while (this.queue.length && this.window.length < s.rpm && this.active < s.concurrency) {
      const w = this.queue.shift()!;
      this.window.push(Date.now());
      this.active++;
      w.resolve();
      moved = true;
    }
    if (moved) this.announce();
    if (this.queue.length && !this.timer) {
      const wait = this.window.length >= s.rpm ? Math.max(50, this.window[0]! + 60_000 - Date.now()) : 250;
      this.timer = setTimeout(() => { this.timer = null; this.drain(); }, wait);
    }
  }

  private async countUser(uid: string, now = Date.now()): Promise<void> {
    const day = new Date(now).toISOString().slice(0, 10);
    const limit = this.settings().daily;
    await this.storage.transaction(async (tx) => {
      const n = (await tx.get<number>(`user:${uid}:${day}`)) ?? 0;
      if (n >= limit) throw new ApiError(`Daily AI allowance reached (${limit} requests). It resets at 00:00 UTC; manual import is available.`, 429, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - now) / 1000));
      await tx.put(`user:${uid}:${day}`, n + 1);
    });
  }
  private async countDay(now = Date.now()) {
    const day = new Date(now).toISOString().slice(0, 10);
    await this.storage.put(`day:${day}`, ((await this.storage.get<number>(`day:${day}`)) ?? 0) + 1);
  }

  /** One provider call inside a slot. Never relays upstream bodies (they can carry diagnostics). */
  private async call(system: string, content: unknown[], signal: AbortSignal, onPosition: (n: number) => void): Promise<string> {
    await this.acquire(onPosition, signal);
    try {
      await this.countDay();
      const timeout = AbortSignal.timeout(this.settings().timeoutMs);
      let r: Response;
      try {
        r = await fetch(PROVIDER_URL, { method: 'POST', headers: { Authorization: `Bearer ${this.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(providerBody(this.env, system, content)), signal: AbortSignal.any([signal, timeout]), redirect: 'manual' });
      } catch (e) {
        if (signal.aborted) throw new ApiError('Import cancelled', 499);
        throw new ApiError((e as Error).name === 'TimeoutError' ? 'NVIDIA took too long to answer. Retry with fewer pages.' : 'NVIDIA could not be reached. Retry this batch.', 503);
      }
      // workerd has no redirect: 'error'; a redirect from the provider is a failure, never followed.
      if (!r.ok || (r.status >= 300 && r.status < 400)) {
        await r.body?.cancel();
        if (r.status === 401 || r.status === 403) throw new ApiError('NVIDIA rejected the key or the model. Ask an admin to check the AI panel.', 502);
        throw new ApiError('NVIDIA is busy or unavailable. Retry this batch.', 503, 5);
      }
      const body = (await r.json()) as { choices?: { finish_reason?: string; message?: { content?: string } }[] };
      const choice = body.choices?.[0];
      if (!choice?.message?.content) throw new ApiError('NVIDIA returned an empty answer. Retry this batch.', 502);
      if (choice.finish_reason === 'length') throw new ApiError('The answer was cut off. Process fewer pages and retry.', 502);
      return choice.message.content;
    } finally {
      this.release();
    }
  }

  private async run(uid: string, task: AiTask, input: TaskInput[AiTask], signal: AbortSignal, send: (o: Obj) => void): Promise<unknown> {
    await this.countUser(uid);
    const spec = PROMPTS[task] as { system: string; user: (i: unknown) => unknown[] };
    const onPosition = (n: number) => send({ type: 'queued', position: n });
    let reply = await this.call(spec.system, spec.user(input), signal, onPosition);
    let problems = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch {
        problems = 'The reply is not valid JSON.';
        parsed = undefined;
      }
      if (parsed !== undefined) {
        try { return checkOutput(task, parsed, input); } catch (e) { problems = (e as Error).message; }
      }
      if (attempt === 1) break;
      send({ type: 'repairing' });
      reply = await this.call(REPAIR.system, REPAIR.user(task, reply, problems), signal, onPosition);
    }
    throw new ApiError(`The AI reply still had problems after one repair: ${problems.slice(0, 600)}. Retry this batch with fewer pages, or import by hand.`, 422);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path === '/status') {
      const now = Date.now();
      this.prune(now);
      const day = new Date(now).toISOString().slice(0, 10);
      return json({ configured: !!this.env.NVIDIA_API_KEY, model: model(this.env), minute: this.window.length, rpm: this.settings().rpm, today: (await this.storage.get<number>(`day:${day}`)) ?? 0, queue: this.queue.length, active: this.active, dailyPerAccount: this.settings().daily, prompts: AI_TASKS.map((t) => ({ task: t, prompt: PROMPTS[t].id, version: PROMPTS[t].version })) });
    }
    if (path === '/test') {
      try {
        const reply = await this.call('Reply with the JSON object {"ok":true} and nothing else.', [{ type: 'text', text: 'ping' }], new AbortController().signal, () => {});
        return json({ ok: true, model: model(this.env), reply: reply.slice(0, 80) });
      } catch (e) {
        return json({ ok: false, model: model(this.env), error: e instanceof ApiError ? e.message : 'Request failed' }, 200);
      }
    }
    if (path !== '/run') return json({ error: 'Not found' }, 404);
    const uid = req.headers.get('X-Account-ID');
    if (!uid) return json({ error: 'Unauthorized' }, 401);
    const { task, input } = (await req.json()) as { task: AiTask; input: TaskInput[AiTask] };
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const w = stream.writable.getWriter();
    const enc = new TextEncoder();
    let open = true;
    const send = (o: Obj) => { if (open) void w.write(enc.encode(`${JSON.stringify(o)}\n`)).catch(() => { open = false; }); };
    const done = (async () => {
      try {
        const data = await this.run(uid, task, input, req.signal, send);
        send({ type: 'result', data });
      } catch (e) {
        const err = e instanceof ApiError ? e : new ApiError('AI service unavailable. Retry this batch; manual import remains available.', 503);
        send({ type: 'error', status: err.status, error: err.message, ...(err.retryAfter !== undefined ? { retryAfter: err.retryAfter } : {}) });
      } finally {
        open = false;
        await w.close().catch(() => {});
      }
    })();
    void done;
    return new Response(stream.readable, { headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' } });
  }
}
