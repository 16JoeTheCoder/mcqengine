/** HTTP helpers: errors that are safe to show, JSON responses, bounded body reads, input checks. */
export class ApiError extends Error {
  constructor(message: string, public status = 400, public retryAfter?: number) { super(message); }
}

const BASE_HEADERS = { 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' };

export function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...BASE_HEADERS, ...extra } });
}

/** Only ApiError messages reach the client; anything else is logged and answered generically. */
export function fail(e: unknown, route: string): Response {
  if (e instanceof ApiError) return json({ error: e.message }, e.status, e.retryAfter !== undefined ? { 'Retry-After': String(e.retryAfter) } : {});
  console.error(JSON.stringify({ level: 'error', route, message: (e as Error)?.message?.slice(0, 500) ?? String(e) }));
  return json({ error: 'Something went wrong on the server. Try again in a moment.' }, 500);
}

export async function readBytes(req: Request | Response, max: number): Promise<Uint8Array> {
  if (Number(req.headers.get('content-length')) > max) throw new ApiError('Request is too large', 413);
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    bytes += part.value.byteLength;
    if (bytes > max) { await reader.cancel(); throw new ApiError('Request is too large', 413); }
    chunks.push(part.value);
  }
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export async function readJson(req: Request | Response, max = 1_000_000): Promise<unknown> {
  if (!req.headers.get('content-type')?.includes('application/json')) throw new ApiError('Send JSON', 415);
  const bytes = await readBytes(req, max);
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError('Invalid JSON'); }
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export function obj(v: unknown, keys: string[], what = 'request'): Obj {
  if (!isObj(v)) throw new ApiError(`Invalid ${what}`);
  const extra = Object.keys(v).find((k) => !keys.includes(k));
  if (extra) throw new ApiError(`Unexpected field "${extra.slice(0, 40)}" in ${what}`);
  return v;
}
export function str(v: unknown, name: string, max: number, min = 0): string {
  if (typeof v !== 'string' || v.length > max || v.trim().length < min) throw new ApiError(`${name} must be text of ${min ? `${min} to ` : 'at most '}${max} characters`);
  return v;
}
export function int(v: unknown, name: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ApiError(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
export function uuid(v: unknown, name = 'ID'): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new ApiError(`${name} must be a lowercase UUID`);
  return v;
}
export function hash(v: unknown): string {
  if (typeof v !== 'string' || !SHA256.test(v)) throw new ApiError('File hash must be 64 lowercase hex characters');
  return v;
}
export function email(v: unknown): string {
  const e = typeof v === 'string' ? v.trim().toLowerCase() : '';
  if (e.length > 254 || !/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) throw new ApiError('Enter a valid email address');
  return e;
}

export function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? new TextEncoder().encode(data) : data));
}
export const today = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
