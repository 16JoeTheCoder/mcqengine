import type { PublishedManifest, SetManifest } from '../../../shared/manifest';

/**
 * The backend the app talks to: the DMC Worker on Cloudflare in production, an in-browser mock
 * in development and tests. Access rules live on the server (worker/*.ts); the client only reads
 * the server's verdict (`status`) to decide what to show.
 */
export interface Account {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /** Profile address, `#/u/<handle>`. */
  handle?: string;
}

export interface LibraryStatus {
  member: boolean;
  admin: boolean;
}

export interface Me {
  account: Account | null;
  status: LibraryStatus;
  /** On by default for school accounts, off for personal ones. Settings can override it. */
  syncDefault: boolean;
  quota?: { used: number; limit: number };
}

export interface LibrarySet {
  id: string;
  owner: string;
  ownerName: string;
  title: string;
  description: string;
  subject: string;
  code: string;
  paperCount: number;
  questionCount: number;
  keyed: boolean;
  /** Latest version number. */
  version: number;
  bytes: number;
  coverHash: string | null;
  status: 'approved' | 'hidden';
  stars: number;
  starred: boolean;
  reports: number;
  createdAt: string;
  updatedAt: string;
  mine: boolean;
}

export interface SyncRecord {
  store: 'packs' | 'sessions' | 'sessionDetail' | 'questionStats' | 'snips' | 'overrides' | 'settings';
  id: string;
  updated_at: number;
  base_updated_at?: number;
  server_revision?: string;
  deleted?: boolean;
  data: unknown;
}

export interface RegistryPaper { key: string; msKey: string; qp: string | null; ms: string | null; questionCount: number | null }
export interface ProfileStats { sessions?: number; questions?: number; accuracy?: number; papers?: number; streak?: number }
export interface ProfileSet { id: string; title: string; subject: string; paperCount: number; questionCount: number; stars: number; version: number; updatedAt: number | string }
export interface Profile {
  handle: string;
  name: string;
  headline: string;
  bio: string;
  subjects: string[];
  avatar: string | null;
  joined: number | string;
  mine: boolean;
  /** Only for the owner and admins. */
  visibility?: 'school' | 'private';
  showStats: boolean;
  stats: ProfileStats | null;
  starsReceived: number;
  sets: ProfileSet[];
}
export interface ProfilePatch { handle?: string; headline?: string; bio?: string; subjects?: string[]; visibility?: 'school' | 'private'; showStats?: boolean; stats?: ProfileStats }
export interface SearchResults {
  sets: { id: string; title: string; subject: string; ownerName: string; paperCount: number; version: number }[];
  people: { handle: string; name: string; headline: string }[];
}

/** A paper to find in the Library: its question paper hash, text fingerprint, Cambridge code. */
export interface PaperAsk { qp?: string; fp?: string; key?: string }
/** A paper the Library already has: link these files instead of uploading. */
export interface PaperMatch { qp: string; ms: string | null; questionCount: number | null; label: string | null; how: 'file' | 'text' | 'code'; similarity: number }


export interface Backend {
  kind: 'cloudflare' | 'mock';
  me(): Promise<Me>;
  /** Current account, or null when signed out. */
  account(): Promise<Account | null>;
  onAuthChange(fn: (a: Account | null) => void): () => void;
  /** Google sign-in: leaves the page for Google and comes back to `returnTo`. `school` only pre-selects the school account. */
  signInGoogle(school: boolean, returnTo?: string): Promise<void>;
  /** Development and tests only: sign in as an email without Google. */
  signInDev?(email: string): Promise<void>;
  signOut(): Promise<void>;
  status(): Promise<LibraryStatus>;
  updateName(name: string): Promise<string>;

  listSets(o: { search: string; limit: number; offset: number }): Promise<LibrarySet[]>;
  getSet(id: string, version?: number): Promise<{ set: LibrarySet; manifest: PublishedManifest }>;
  lookupPapers(keys: string[]): Promise<RegistryPaper[]>;
  /** Library sets and profiles this account may see (empty for non-members). */
  search(q: string, signal?: AbortSignal): Promise<SearchResults>;
  profile(handle: string): Promise<Profile>;
  updateProfile(patch: ProfilePatch): Promise<{ handle: string }>;
  /** A square photo (WebP, at most 512 KB), or null to remove it. */
  setAvatar(photo: Blob | null): Promise<void>;
  reportProfile(handle: string, reason: string): Promise<void>;
  /** Same paper by file hash, then text fingerprint, then Cambridge code (null: not in the Library). */
  matchPapers(papers: PaperAsk[]): Promise<(PaperMatch | null)[]>;
  /** Hashes the server does not have yet. */
  checkBlobs(hashes: string[]): Promise<string[]>;
  uploadBlob(hash: string, blob: Blob, type: string, onProgress: (sent: number) => void, signal: AbortSignal): Promise<void>;
  getBlob(hash: string, signal?: AbortSignal): Promise<Blob | null>;
  /** A URL an <img> can show (same-origin for the Worker; an object URL for the mock). */
  blobUrl(hash: string): Promise<string | null>;
  publishVersion(setId: string, base: number, manifest: SetManifest): Promise<{ version: number }>;
  updateSet(id: string, patch: { title?: string; description?: string; subject?: string; status?: 'approved' | 'hidden' }): Promise<void>;
  deleteSet(id: string): Promise<void>;
  star(setId: string, on: boolean): Promise<void>;
  report(setId: string, reason: string): Promise<void>;

  syncPush(records: SyncRecord[], expectedAccount?: string): Promise<number>;
  /** Records changed on the server after `cursor` (opaque), oldest first. */
  syncPull(cursor: string | null, limit: number, expectedAccount?: string): Promise<{ records: SyncRecord[]; cursor: string | null }>;

  /** One private zip of the account's own packs. */
  putBackup(blob: Blob, onProgress: (sent: number) => void): Promise<void>;
  getBackup(): Promise<Blob | null>;

  /** Admin panel: GET a JSON route under /api/admin/. */
  admin<T = unknown>(path: string, init?: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown }): Promise<T>;
}

export class BackendError extends Error {
  constructor(message: string, public status = 0, public retryAfter?: number) { super(message); }
}

/** The school email domains. The server's library_domains table is the authority; this is for hints. */
export const SCHOOL_DOMAINS = ['stjbs.sch.id'];
export const isSchoolEmail = (email: string) => SCHOOL_DOMAINS.includes((email.split('@')[1] ?? '').toLowerCase());
