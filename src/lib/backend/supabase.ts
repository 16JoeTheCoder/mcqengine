import type { SupabaseClient, User } from '@supabase/supabase-js';
import { BackendError, SCHOOL_DOMAINS, type Account, type Backend, type LibrarySet } from './types';

/**
 * Supabase implementation. Only the project URL and the public anon key reach the browser; every
 * rule is enforced by row-level security and storage policies (supabase/schema.sql). supabase-js
 * loads on first use, so people who never sign in never download it.
 */
export function createSupabaseBackend(url: string, anonKey: string): Backend {
  let cp: Promise<SupabaseClient> | null = null;
  const client = () =>
    (cp ??= import('@supabase/supabase-js').then(({ createClient }) =>
      createClient(url, anonKey, { auth: { flowType: 'pkce', detectSessionInUrl: true, persistSession: true, autoRefreshToken: true, storageKey: 'dmc-auth' } }),
    ));
  const toAccount = (u: User | null | undefined): Account | null =>
    u?.email ? { id: u.id, email: u.email, emailVerified: !!u.email_confirmed_at, name: String(u.user_metadata?.full_name ?? u.user_metadata?.name ?? u.email.split('@')[0]) } : null;
  const ok = <T>(r: { data: T; error: { message: string } | null } | { data: unknown; error: { message: string } }): T => {
    if (r.error) throw new BackendError(r.error.message);
    return r.data as T;
  };
  const redirect = () => `${location.origin}${location.pathname}`;
  const uid = async () => {
    const { data } = await (await client()).auth.getUser();
    if (!data.user) throw new BackendError('Sign in first');
    return data.user.id;
  };
  const clean = (s: string) => s.replace(/[,()%*\\]/g, ' ').trim().slice(0, 80);

  return {
    kind: 'supabase',
    async account() {
      const c = await client();
      // After an OAuth or email-link redirect, supabase-js exchanges ?code=… for a session; then tidy the URL.
      const { data } = await c.auth.getSession();
      if (location.search.includes('code=')) history.replaceState(null, '', `${location.pathname}${location.hash}`);
      return toAccount(data.session?.user);
    },
    onAuthChange(fn) {
      let off = () => {};
      void client().then((c) => {
        const { data } = c.auth.onAuthStateChange((_e, s) => fn(toAccount(s?.user)));
        off = () => data.subscription.unsubscribe();
      });
      return () => off();
    },
    async signInGoogle(school) {
      // The hosted-domain hint only pre-selects the school account in Google's chooser. It is not a
      // check: the server's policies decide who reaches the Library.
      ok(await (await client()).auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirect(), queryParams: school ? { hd: SCHOOL_DOMAINS[0]!, prompt: 'select_account' } : { prompt: 'select_account' } } }));
    },
    async signInEmail(email) {
      ok(await (await client()).auth.signInWithOtp({ email: email.trim(), options: { emailRedirectTo: redirect(), shouldCreateUser: true } }));
    },
    async signOut() {
      await (await client()).auth.signOut();
    },
    async status() {
      const c = await client();
      const { data } = await c.auth.getSession();
      if (!data.session) return { member: false, admin: false };
      return ok(await c.rpc('library_status')) as { member: boolean; admin: boolean };
    },

    async listSets({ search, limit, offset }) {
      const c = await client();
      const me = await uid();
      let q = c.from('sets').select('*').order('star_count', { ascending: false }).order('created_at', { ascending: false }).range(offset, offset + limit - 1);
      const t = clean(search);
      if (t) q = q.or(['title', 'description', 'subject', 'code'].map((f) => `${f}.ilike.%${t}%`).join(','));
      const rows = ok(await q) as Record<string, unknown>[];
      const ids = rows.map((r) => r.id as string);
      const stars = ids.length ? (ok(await c.from('stars').select('set_id').in('set_id', ids)) as { set_id: string }[]) : [];
      const starred = new Set(stars.map((s) => s.set_id));
      return rows.map(
        (r): LibrarySet => ({
          id: r.id as string,
          owner: r.owner as string,
          ownerName: r.owner_name as string,
          title: r.title as string,
          description: r.description as string,
          subject: r.subject as string,
          code: r.code as string,
          paperCount: r.paper_count as number,
          questionCount: r.question_count as number,
          keyed: r.keyed as boolean,
          stars: r.star_count as number,
          starred: starred.has(r.id as string),
          status: r.status as 'approved' | 'hidden',
          reports: r.report_count as number,
          createdAt: r.created_at as string,
          filePath: r.file_path as string,
          fileSize: r.file_size as number,
          coverPath: (r.cover_path as string | null) ?? null,
          mine: r.owner === me,
        }),
      );
    },
    async createSet(id, m) {
      const me = await uid();
      const filePath = `${me}/${id}/pack.zip`;
      const coverPath = m.hasCover ? `${me}/${id}/cover.${m.coverExt}` : null;
      ok(
        await (await client()).from('sets').insert({ id, owner_name: m.ownerName.slice(0, 80), title: m.title.slice(0, 120), description: m.description.slice(0, 1000), subject: m.subject.slice(0, 80), code: m.code.slice(0, 20), paper_count: m.paperCount, question_count: m.questionCount, keyed: m.keyed, file_path: filePath, file_size: m.fileSize, cover_path: coverPath }),
      );
      return { filePath, coverPath };
    },
    async upload(bucket, u, onProgress, signal, upsert = false) {
      // XMLHttpRequest rather than supabase-js, for upload progress and cancel.
      const { data } = await (await client()).auth.getSession();
      const token = data.session?.access_token;
      if (!token) throw new BackendError('Sign in first');
      const path = u.path.split('/').map(encodeURIComponent).join('/');
      await new Promise<void>((resolve, reject) => {
        const x = new XMLHttpRequest();
        x.open('POST', `${url}/storage/v1/object/${bucket}/${path}`);
        x.setRequestHeader('Authorization', `Bearer ${token}`);
        x.setRequestHeader('apikey', anonKey);
        x.setRequestHeader('Content-Type', u.contentType);
        x.setRequestHeader('x-upsert', upsert ? 'true' : 'false');
        x.upload.onprogress = (e) => onProgress(e.loaded);
        x.onload = () => (x.status < 300 ? resolve() : reject(new BackendError(x.status === 409 ? 'The file already exists' : `Upload refused (${x.status})`)));
        x.onerror = () => reject(new BackendError('Network error during upload'));
        x.onabort = () => reject(new DOMException('Cancelled', 'AbortError'));
        signal.addEventListener('abort', () => x.abort(), { once: true });
        x.send(u.blob);
      });
    },
    async deleteSet(s) {
      const c = await client();
      ok(await c.storage.from('sets').remove([s.filePath, ...(s.coverPath ? [s.coverPath] : [])]));
      ok(await c.from('sets').delete().eq('id', s.id));
    },
    async updateSet(id, patch) {
      ok(await (await client()).from('sets').update(patch).eq('id', id));
    },
    async signedUrl(bucket, path) {
      const r = await (await client()).storage.from(bucket).createSignedUrl(path, 60);
      return r.error ? null : r.data.signedUrl;
    },
    async download(bucket, path) {
      const u = await this.signedUrl(bucket, path);
      if (!u) return null;
      const res = await fetch(u);
      return res.ok ? res.blob() : null;
    },
    async star(setId, on) {
      const c = await client();
      if (on) ok(await c.from('stars').insert({ set_id: setId }));
      else ok(await c.from('stars').delete().eq('set_id', setId).eq('user_id', await uid()));
    },
    async report(setId, reason) {
      ok(await (await client()).from('reports').insert({ set_id: setId, reason: reason.slice(0, 500) }));
    },
    async syncPush(records) {
      return ok(await (await client()).rpc('sync_push', { records })) as number;
    },
    async syncPull(cursor, limit) {
      const rows = ok(
        await (await client()).from('sync_records').select('store,id,updated_at,deleted,data,synced_at').gt('synced_at', cursor ?? '1970-01-01T00:00:00Z').order('synced_at').limit(limit),
      ) as (Record<string, unknown> & { synced_at: string })[];
      return {
        records: rows.map((r) => ({ store: r.store as never, id: r.id as string, updated_at: Number(r.updated_at), deleted: !!r.deleted, data: r.data })),
        cursor: rows.length ? rows[rows.length - 1]!.synced_at : cursor,
      };
    },
  };
}
