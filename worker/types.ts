/**
 * The small part of the Workers runtime API this Worker uses, written out so the project needs no
 * generated type package. Shapes follow @cloudflare/workers-types.
 */
export interface D1Result<T = Record<string, unknown>> { results: T[]; success: boolean; meta: { changes: number; last_row_id: number; rows_read?: number; rows_written?: number } }
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
  raw<T = unknown[]>(): Promise<T[]>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number }>;
}

export interface R2Object { key: string; size: number; etag: string; httpEtag: string; uploaded: Date; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
export interface R2ObjectBody extends R2Object { body: ReadableStream<Uint8Array>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }
export interface R2Objects { objects: R2Object[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[] }
export interface R2Bucket {
  head(key: string): Promise<R2Object | null>;
  get(key: string, options?: { range?: { offset: number; length?: number } | { suffix: number } }): Promise<R2ObjectBody | null>;
  put(key: string, value: ReadableStream | ArrayBuffer | Uint8Array | string | Blob | null, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; sha256?: string }): Promise<R2Object | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; delimiter?: string }): Promise<R2Objects>;
}

export interface DurableObjectStub { fetch(request: Request): Promise<Response> }
export interface DurableObjectNamespace { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub }
export interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  transaction<T>(fn: (tx: DurableObjectStorage) => Promise<T>): Promise<T>;
}

export interface RateLimit { limit(options: { key: string }): Promise<{ success: boolean }> }
export interface Fetcher { fetch(request: Request): Promise<Response> }
export interface ExecutionContext { waitUntil(p: Promise<unknown>): void; passThroughOnException?(): void }
export interface ScheduledController { cron: string; scheduledTime: number }

export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AI_BUDGET: DurableObjectNamespace;
  ASSETS?: Fetcher;
  /** Workers Rate Limiting bindings (wrangler.toml [[ratelimits]]). Absent locally: no limit. */
  UPLOAD_LIMITER?: RateLimit;
  ERROR_LIMITER?: RateLimit;
  WRITE_LIMITER?: RateLimit;
  ENVIRONMENT?: string;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SESSION_SECRET?: string;
  /** Local development only: enables POST /api/auth/dev. Refused unless ENVIRONMENT is "local". */
  DEV_LOGIN?: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_MODEL?: string;
  AI_SHARED_RPM?: string;
  AI_USER_DAILY_REQUESTS?: string;
  AI_CONCURRENCY?: string;
  AI_MAX_PAGES?: string;
  AI_TIMEOUT_MS?: string;
  AI_MAX_RETRIES?: string;
  AI_QUEUE_MAX?: string;
}

declare global {
  // workerd extensions used for verified streaming uploads.
  class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> { constructor(length: number | bigint) }
  interface Crypto { DigestStream: new (algorithm: string) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> } }
  interface CacheStorage { default: Cache }
}
