import { readFileSync, readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

/**
 * Runs the real Worker in workerd (Miniflare) with real D1 and R2.
 * Outbound fetches (Google) go to `outbound`, so tests never reach the internet.
 */
export type Outbound = (req: Request) => Promise<Response> | Response;
let bundled: string | null = null;

async function bundle(): Promise<string> {
  if (bundled) return bundled;
  // Inside the repository: workerd refuses module paths outside its working directory.
  mkdirSync('node_modules/.cache', { recursive: true });
  const dir = mkdtempSync(join('node_modules/.cache', 'dmc-worker-'));
  const out = join(dir, 'worker.mjs');
  await build({ entryPoints: ['worker/index.ts'], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outfile: out, logLevel: 'silent', mainFields: ['module', 'main'] });
  return (bundled = out);
}

export function migrationStatements(): string[] {
  const files = readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort();
  return files.flatMap((f) => {
    const out: string[] = [];
    let cur = '';
    const lines = readFileSync(join('migrations', f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--'));
    for (const line of lines) {
      cur += `${line}\n`;
      // A trigger body holds semicolons: it ends at END;, any other statement at the first semicolon.
      const inTrigger = /^\s*CREATE\s+TRIGGER/im.test(cur);
      if (inTrigger ? /\bEND;\s*$/i.test(cur) : /;\s*$/.test(cur)) { out.push(cur.trim()); cur = ''; }
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  });
}

export interface Harness {
  mf: Miniflare;
  fetch(path: string, init?: RequestInit & { as?: string }): Promise<Response>;
  /** Signs a user in directly (a session row), returning the cookie header value. */
  signIn(email: string, opts?: { hd?: string | null; verified?: boolean; name?: string }): Promise<{ cookie: string; id: string }>;
  sql<T = Record<string, unknown>>(q: string, ...binds: unknown[]): Promise<T[]>;
  scheduled(time?: number): Promise<void>;
  setOutbound(fn: Outbound): void;
  dispose(): Promise<void>;
}

export async function startWorker(vars: Record<string, string> = {}): Promise<Harness> {
  let outbound: Outbound = () => new Response('offline', { status: 599 });
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    scriptPath: await bundle(),
    compatibilityDate: '2026-10-01',
    d1Databases: { DB: 'dmc-test' },
    r2Buckets: ['FILES'],
    bindings: { ENVIRONMENT: 'test', SESSION_SECRET: 'test-secret-0123456789abcdef0123456789', GOOGLE_CLIENT_ID: 'client-1.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'shh', ...vars },
    outboundService: (req: unknown) => outbound(req as Request) as never,
  } as never));
  const db = await mf.getD1Database('DB');
  await db.batch(migrationStatements().map((s) => db.prepare(s)));
  const users = new Map<string, string>();
  const h: Harness = {
    mf,
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (init.as) headers.set('cookie', `__Host-dmc_session=${init.as}`);
      if (init.method && !['GET', 'HEAD'].includes(init.method) && !headers.has('x-dmc')) headers.set('x-dmc', '1');
      if (typeof init.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
      return (await mf.dispatchFetch(`http://localhost${path}`, { ...init, headers } as never)) as unknown as Response;
    },
    async signIn(email, opts = {}) {
      const id = users.get(email) ?? crypto.randomUUID();
      const domain = email.split('@')[1]!;
      const hd = opts.hd === undefined ? (domain === 'stjbs.sch.id' ? domain : null) : opts.hd;
      await db.prepare('INSERT OR REPLACE INTO users (id, email, email_verified, google_sub, hd, display_name, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 0)')
        .bind(id, email, opts.verified === false ? 0 : 1, `sub-${email}`, hd, opts.name ?? email.split('@')[0]).run();
      users.set(email, id);
      const token = randomBytes(32).toString('base64url');
      const hash = createHash('sha256').update(token).digest('hex');
      const now = Date.now();
      await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, absolute_expires_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?3)').bind(hash, id, now, now + 86_400_000, now + 2 * 86_400_000).run();
      return { cookie: token, id };
    },
    async sql(q, ...binds) {
      return (await db.prepare(q).bind(...binds).all()).results as never;
    },
    async scheduled(time = Date.now()) {
      const w = (await mf.getWorker()) as unknown as { scheduled(o: { scheduledTime: Date; cron: string }): Promise<unknown> };
      await w.scheduled({ scheduledTime: new Date(time), cron: '0 17 * * *' });
    },
    setOutbound(fn) { outbound = fn; },
    dispose: () => mf.dispose(),
  };
  return h;
}

export const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
export const pdfBytes = (label: string, size = 2000) => {
  const b = new Uint8Array(size);
  b.set(new TextEncoder().encode(`%PDF-1.7\n% ${label}\n`));
  return b;
};
export const pngBytes = (label: string) => {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return new Uint8Array([...head, ...new TextEncoder().encode(label.padEnd(64, '.'))]);
};
