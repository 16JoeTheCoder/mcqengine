/**
 * The backend the app talks to: Supabase in production, an in-browser mock in development and
 * tests. Access rules live on the server (supabase/schema.sql); the client only reads the
 * server's verdict (`status`) to decide what to show.
 */
export interface Account {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

export interface LibraryStatus {
  member: boolean;
  admin: boolean;
}

export interface SetMeta {
  title: string;
  description: string;
  subject: string;
  code: string;
  paperCount: number;
  questionCount: number;
  keyed: boolean;
}

export interface LibrarySet extends SetMeta {
  id: string;
  owner: string;
  ownerName: string;
  stars: number;
  starred: boolean;
  status: 'approved' | 'hidden';
  reports: number;
  createdAt: string;
  filePath: string;
  fileSize: number;
  coverPath: string | null;
  mine: boolean;
}

export interface SyncRecord {
  store: 'packs' | 'sessions' | 'sessionDetail' | 'questionStats' | 'snips' | 'overrides' | 'settings';
  id: string;
  updated_at: number;
  deleted?: boolean;
  data: unknown;
}

export interface Upload {
  /** Path inside the bucket. */
  path: string;
  blob: Blob;
  contentType: string;
}

export interface Backend {
  kind: 'supabase' | 'mock';
  /** Current account, or null when signed out. */
  account(): Promise<Account | null>;
  onAuthChange(fn: (a: Account | null) => void): () => void;
  /** Google sign-in. `school` adds the school domain as a hint to Google's account chooser only. */
  signInGoogle(school: boolean): Promise<void>;
  /** Email sign-in link (also creates the account). Mock: signs in at once. */
  signInEmail(email: string): Promise<void>;
  signOut(): Promise<void>;
  status(): Promise<LibraryStatus>;

  listSets(o: { search: string; limit: number; offset: number }): Promise<LibrarySet[]>;
  /** Creates the set row (the server checks membership, folder and quota). */
  createSet(id: string, meta: SetMeta & { ownerName: string; fileSize: number; hasCover: boolean; coverExt: string }): Promise<{ filePath: string; coverPath: string | null }>;
  upload(bucket: 'sets' | 'backups', u: Upload, onProgress: (sent: number) => void, signal: AbortSignal, upsert?: boolean): Promise<void>;
  /** Removes a set's files, then its row (owner or admin). */
  deleteSet(s: LibrarySet): Promise<void>;
  updateSet(id: string, patch: { title?: string; description?: string; status?: 'approved' | 'hidden' }): Promise<void>;
  /** A short-lived URL for a file the caller may read. */
  signedUrl(bucket: 'sets' | 'backups', path: string): Promise<string | null>;
  download(bucket: 'sets' | 'backups', path: string): Promise<Blob | null>;
  star(setId: string, on: boolean): Promise<void>;
  report(setId: string, reason: string): Promise<void>;

  syncPush(records: SyncRecord[]): Promise<number>;
  /** Records changed on the server after `cursor` (opaque), oldest first. */
  syncPull(cursor: string | null, limit: number): Promise<{ records: SyncRecord[]; cursor: string | null }>;
}

export class BackendError extends Error {}

/** The school email domains. The server's library_domains table is the authority; this is for hints. */
export const SCHOOL_DOMAINS = ['stjbs.sch.id'];
export const isSchoolEmail = (email: string) => SCHOOL_DOMAINS.includes((email.split('@')[1] ?? '').toLowerCase());
