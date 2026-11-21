// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { sha, startWorker, type Harness } from './worker-harness';

const CLIENT = 'client-1.apps.googleusercontent.com';
const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString('base64url');

interface Pair { privateKey: CryptoKey; jwk: JsonWebKey & { kid: string; alg: string; use: string } }
async function makePair(kid: string): Promise<Pair> {
  const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as JsonWebKey;
  return { privateKey: kp.privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } };
}
async function signJwt(pair: Pair, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'RS256', kid: pair.jwk.kid, typ: 'JWT', ...header })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

let h: Harness;
let key: Pair;
let other: Pair;
let tokenForm: URLSearchParams | null = null;
let idToken = '';
let n = 0;

const setCookies = (r: Response) => r.headers.getSetCookie();
const pair = (r: Response, name: string) => setCookies(r).map((c) => c.split(';')[0]!).find((c) => c.startsWith(`${name}=`));

async function start(query = 'return=%23%2Flibrary&school=1', worker = h) {
  const r = await worker.fetch(`/api/auth/google?${query}`, { redirect: 'manual' } as RequestInit);
  const loc = new URL(r.headers.get('location')!);
  return { r, loc, state: loc.searchParams.get('state')!, nonce: loc.searchParams.get('nonce')!, oauth: pair(r, '__Host-dmc_oauth')! };
}

interface Opts { claims?: Record<string, unknown>; signer?: Pair; header?: Record<string, unknown>; state?: string; cookie?: string | null; rawToken?: string; query?: string }
/** Runs a whole sign-in with the given claim overrides; returns the callback response. */
async function flow(o: Opts = {}) {
  const s = await start(o.query);
  const now = Math.floor(Date.now() / 1000);
  n++;
  const claims = { iss: 'https://accounts.google.com', aud: CLIENT, sub: `sub-${n}`, email: `user${n}@x.com`, email_verified: true, nonce: s.nonce, iat: now, exp: now + 3600, ...o.claims };
  for (const k of Object.keys(claims)) if ((claims as Record<string, unknown>)[k] === undefined) delete (claims as Record<string, unknown>)[k];
  idToken = o.rawToken ?? await signJwt(o.signer ?? key, claims, o.header);
  const cookie = o.cookie === undefined ? s.oauth : o.cookie;
  const r = await h.fetch(`/api/auth/google/callback?code=abc&state=${encodeURIComponent(o.state ?? s.state)}`, { redirect: 'manual', headers: cookie ? { cookie } : {} } as RequestInit);
  return { r, claims, s };
}
const sessionCount = async () => Number((await h.sql<{ c: number }>('SELECT count(*) AS c FROM sessions'))[0]!.c);

beforeAll(async () => {
  key = await makePair('kid-1');
  other = await makePair('kid-1');
  h = await startWorker();
  h.setOutbound(async (req) => {
    const url = req.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenForm = new URLSearchParams(await req.text());
      return Response.json({ id_token: idToken });
    }
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [key.jwk] });
    return new Response('nope', { status: 599 });
  });
}, 60_000);
afterAll(async () => { await h.dispose(); });

describe('Google sign-in flow', () => {
  it('starts with PKCE, state, nonce and the school hint', async () => {
    const { r, loc, oauth } = await start();
    expect(r.status).toBe(302);
    expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(loc.searchParams.get('client_id')).toBe(CLIENT);
    expect(loc.searchParams.get('code_challenge')).toBeTruthy();
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(loc.searchParams.get('state')).toBeTruthy();
    expect(loc.searchParams.get('nonce')).toBeTruthy();
    expect(loc.searchParams.get('hd')).toBe('stjbs.sch.id');
    expect(loc.searchParams.get('prompt')).toBe('select_account');
    expect(loc.searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/google/callback');
    expect(oauth).toBeTruthy();
    const raw = setCookies(r).find((c) => c.startsWith('__Host-dmc_oauth='))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Lax/);
  });

  it('omits hd without school=1', async () => {
    const { loc } = await start('return=%23%2F');
    expect(loc.searchParams.has('hd')).toBe(false);
  });

  it('completes the flow: PKCE verifier, redirect, session cookie, account, hashed session', async () => {
    const s = await start();
    const now = Math.floor(Date.now() / 1000);
    idToken = await signJwt(key, { iss: 'accounts.google.com', aud: CLIENT, sub: 'sub-josef', email: 'Josef.Yang2@stjbs.sch.id', email_verified: true, hd: 'stjbs.sch.id', nonce: s.nonce, iat: now, exp: now + 3600 });
    tokenForm = null;
    const r = await h.fetch(`/api/auth/google/callback?code=abc&state=${s.state}`, { redirect: 'manual', headers: { cookie: s.oauth } } as RequestInit);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://localhost/#/library');
    expect(tokenForm!.get('code')).toBe('abc');
    expect(tokenForm!.get('grant_type')).toBe('authorization_code');
    expect(tokenForm!.get('client_id')).toBe(CLIENT);
    expect(tokenForm!.get('client_secret')).toBe('shh');
    const verifier = tokenForm!.get('code_verifier')!;
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(s.loc.searchParams.get('code_challenge'));

    const raw = setCookies(r).find((c) => c.startsWith('__Host-dmc_session='))!;
    expect(raw).toMatch(/HttpOnly/);
    expect(raw).toMatch(/Secure/);
    expect(raw).toMatch(/SameSite=Lax/);
    expect(setCookies(r).find((c) => c.startsWith('__Host-dmc_oauth='))).toMatch(/Max-Age=0/);
    const token = pair(r, '__Host-dmc_session')!.split('=')[1]!;

    const me = await (await h.fetch('/api/me', { as: token })).json() as { account: { email: string; name: string; emailVerified: boolean }; status: { member: boolean; admin: boolean }; syncDefault: boolean };
    expect(me.account.email).toBe('josef.yang2@stjbs.sch.id');
    expect(me.account.name).toBe('Josef Yang2');
    expect(me.account.emailVerified).toBe(true);
    expect(me.status.member).toBe(true);
    expect(me.syncDefault).toBe(true);

    const rows = await h.sql<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows.every((x) => /^[0-9a-f]{64}$/.test(x.token_hash))).toBe(true);
    expect(rows.map((x) => x.token_hash)).toContain(sha(token));
    expect(rows.map((x) => x.token_hash)).not.toContain(token);
  });

  it('derives display names from the email', async () => {
    const a = await flow({ claims: { email: 'josef.yang@example.org', sub: 'sub-n1' } });
    const b = await flow({ claims: { email: 'a_b-c@x.com', sub: 'sub-n2' } });
    expect(a.r.headers.get('location')).toBe('http://localhost/#/library');
    for (const [r, name] of [[a.r, 'Josef Yang'], [b.r, 'A B C']] as const) {
      const token = pair(r, '__Host-dmc_session')!.split('=')[1]!;
      const me = await (await h.fetch('/api/me', { as: token })).json() as { account: { name: string } };
      expect(me.account.name).toBe(name);
    }
  });

  it('personal Google accounts are not members and do not sync by default', async () => {
    const { r } = await flow({ claims: { email: 'kid@gmail.com', sub: 'sub-gm' } });
    const token = pair(r, '__Host-dmc_session')!.split('=')[1]!;
    const me = await (await h.fetch('/api/me', { as: token })).json() as { status: { member: boolean; admin: boolean }; syncDefault: boolean };
    expect(me.status).toEqual({ member: false, admin: false });
    expect(me.syncDefault).toBe(false);
  });

  it('a school address without an hd claim is not a member', async () => {
    const { r } = await flow({ claims: { email: 'fake@stjbs.sch.id', sub: 'sub-nohd' } });
    expect(r.headers.get('location')).toBe('http://localhost/#/library');
    const token = pair(r, '__Host-dmc_session')!.split('=')[1]!;
    const me = await (await h.fetch('/api/me', { as: token })).json() as { status: { member: boolean }; syncDefault: boolean };
    expect(me.status.member).toBe(false);
    expect(me.syncDefault).toBe(false);
  });

  it('falls back to #/ for a return value outside the app', async () => {
    for (const q of ['return=https%3A%2F%2Fevil.example', 'return=%2F%2Fevil.example', 'return=javascript%3Aalert(1)', '']) {
      const { r } = await flow({ query: q });
      expect(r.headers.get('location'), q).toBe('http://localhost/#/');
      expect(pair(r, '__Host-dmc_session')).toBeTruthy();
    }
  });

  it('reuses a migrated account row (google_sub NULL) on first Google sign-in', async () => {
    await h.sql("INSERT INTO users (id, email, email_verified, google_sub, hd, display_name, created_at, last_seen_at) VALUES ('migrated-1', 'migrated@x.com', 0, NULL, NULL, 'Old Name', 0, 0)");
    const { r } = await flow({ claims: { email: 'migrated@x.com', sub: 'sub-migrated' } });
    expect(r.headers.get('location')).toBe('http://localhost/#/library');
    const rows = await h.sql<{ id: string; google_sub: string; email_verified: number; display_name: string }>("SELECT id, google_sub, email_verified, display_name FROM users WHERE email = 'migrated@x.com'");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('migrated-1');
    expect(rows[0]!.google_sub).toBe('sub-migrated');
    expect(rows[0]!.email_verified).toBe(1);
    const token = pair(r, '__Host-dmc_session')!.split('=')[1]!;
    const me = await (await h.fetch('/api/me', { as: token })).json() as { account: { id: string } };
    expect(me.account.id).toBe('migrated-1');
  });
});

describe('sign-in rejections', () => {
  const failed = async (o: Opts) => {
    const before = await sessionCount();
    const { r } = await flow(o);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('http://localhost/#/?signin=failed');
    expect(pair(r, '__Host-dmc_session')).toBeUndefined();
    expect(setCookies(r).some((c) => c.startsWith('__Host-dmc_session=') && !/Max-Age=0/.test(c))).toBe(false);
    expect(await sessionCount()).toBe(before);
  };
  const now = () => Math.floor(Date.now() / 1000);

  it('wrong state', () => failed({ state: 'not-the-state' }));
  it('missing oauth cookie', () => failed({ cookie: null }));
  it('tampered oauth cookie', async () => {
    const s = await start();
    const [p, sig] = s.oauth.split('=')[1]!.split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ s: s.state, n: s.nonce, v: 'x', r: '#/', e: Date.now() + 600_000 })).toString('base64url');
    await failed({ cookie: `__Host-dmc_oauth=${forgedPayload}.${sig}` });
    await failed({ cookie: `__Host-dmc_oauth=${p}.AAAA` });
    await failed({ cookie: '__Host-dmc_oauth=garbage' });
  });
  it('expired id token', () => failed({ claims: { exp: now() - 3600, iat: now() - 7200 } }));
  it('wrong audience', () => failed({ claims: { aud: 'someone-else.apps.googleusercontent.com' } }));
  it('wrong issuer', () => failed({ claims: { iss: 'https://evil.example' } }));
  it('wrong nonce', () => failed({ claims: { nonce: 'other-nonce' } }));
  it('missing nonce', () => failed({ claims: { nonce: undefined } }));
  it('unverified email', () => failed({ claims: { email_verified: false } }));
  it('signature from a different key', () => failed({ signer: other }));
  it('alg none', async () => {
    const hdr = b64url(enc.encode(JSON.stringify({ alg: 'none', kid: 'kid-1' })));
    const p = b64url(enc.encode(JSON.stringify({ iss: 'https://accounts.google.com', aud: CLIENT, sub: 'x', email: 'none@x.com', email_verified: true, nonce: 'whatever', iat: now(), exp: now() + 3600 })));
    await failed({ rawToken: `${hdr}.${p}.` });
  });
  it('issued in the future', () => failed({ claims: { iat: now() + 3600, exp: now() + 7200 } }));
  it('unknown key id', async () => {
    const stranger = await makePair('kid-unknown');
    await failed({ signer: stranger });
  });
  it('Google refusing the code', async () => {
    const s = await start();
    h.setOutbound(async (req) => (req.url.endsWith('/token') ? new Response('{}', { status: 400 }) : Response.json({ keys: [key.jwk] })));
    const r = await h.fetch(`/api/auth/google/callback?code=abc&state=${s.state}`, { redirect: 'manual', headers: { cookie: s.oauth } } as RequestInit);
    expect(r.headers.get('location')).toBe('http://localhost/#/?signin=failed');
    h.setOutbound(async (req) => {
      if (req.url === 'https://oauth2.googleapis.com/token') { tokenForm = new URLSearchParams(await req.text()); return Response.json({ id_token: idToken }); }
      return Response.json({ keys: [key.jwk] });
    });
  });
  it('a cancelled sign-in (no code)', async () => {
    const s = await start();
    const r = await h.fetch(`/api/auth/google/callback?state=${s.state}&error=access_denied`, { redirect: 'manual', headers: { cookie: s.oauth } } as RequestInit);
    expect(r.headers.get('location')).toBe('http://localhost/#/?signin=failed');
  });
});

describe('sessions', () => {
  it('roll forward after an hour of use', async () => {
    const { cookie, id } = await h.signIn('roll@x.com');
    const before = (await h.sql<{ expires_at: number; last_used_at: number }>('SELECT expires_at, last_used_at FROM sessions WHERE user_id = ?1', id))[0]!;
    const old = Date.now() - 2 * 3_600_000;
    await h.sql('UPDATE sessions SET last_used_at = ?2 WHERE user_id = ?1', id, old);
    expect((await h.fetch('/api/me', { as: cookie })).status).toBe(200);
    // The roll runs in waitUntil: poll briefly.
    let after = before;
    for (let i = 0; i < 40; i++) {
      after = (await h.sql<{ expires_at: number; last_used_at: number }>('SELECT expires_at, last_used_at FROM sessions WHERE user_id = ?1', id))[0]!;
      if (after.last_used_at > old) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after.last_used_at).toBeGreaterThan(old);
    expect(after.expires_at).toBeGreaterThan(before.expires_at);
  });

  it('does not roll within the hour', async () => {
    const { cookie, id } = await h.signIn('noroll@x.com');
    const before = (await h.sql<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE user_id = ?1', id))[0]!;
    await h.fetch('/api/me', { as: cookie });
    await new Promise((r) => setTimeout(r, 100));
    expect((await h.sql<{ expires_at: number }>('SELECT expires_at FROM sessions WHERE user_id = ?1', id))[0]!.expires_at).toBe(before.expires_at);
  });

  it('an expired session is signed out', async () => {
    const { cookie, id } = await h.signIn('expired@x.com');
    await h.sql('UPDATE sessions SET expires_at = ?2 WHERE user_id = ?1', id, Date.now() - 1000);
    const body = await (await h.fetch('/api/me', { as: cookie })).json() as { account: unknown };
    expect(body.account).toBeNull();
    expect((await h.fetch('/api/sets', { as: cookie })).status).toBe(401);
  });

  it('a session past its absolute expiry is signed out', async () => {
    const { cookie, id } = await h.signIn('absolute@x.com');
    await h.sql('UPDATE sessions SET absolute_expires_at = ?2 WHERE user_id = ?1', id, Date.now() - 1000);
    const body = await (await h.fetch('/api/me', { as: cookie })).json() as { account: unknown };
    expect(body.account).toBeNull();
  });

  it('ignores malformed cookies', async () => {
    const r = await h.fetch('/api/me', { as: 'short' });
    expect(((await r.json()) as { account: unknown }).account).toBeNull();
  });

  it('logout deletes the row and clears the cookie', async () => {
    const { cookie, id } = await h.signIn('bye@x.com');
    const r = await h.fetch('/api/auth/logout', { method: 'POST', as: cookie });
    expect(r.status).toBe(200);
    expect(setCookies(r).find((c) => c.startsWith('__Host-dmc_session='))).toMatch(/Max-Age=0/);
    expect(await h.sql('SELECT 1 FROM sessions WHERE user_id = ?1', id)).toHaveLength(0);
    expect(((await (await h.fetch('/api/me', { as: cookie })).json()) as { account: unknown }).account).toBeNull();
  });
});

describe('dev login and configuration', () => {
  it('is 404 in the test environment', async () => {
    const r = await h.fetch('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email: 'dev@x.com' }) });
    expect(r.status).toBe(404);
  });

  it('works only with ENVIRONMENT=local and DEV_LOGIN=1', async () => {
    const dev = await startWorker({ ENVIRONMENT: 'local', DEV_LOGIN: '1' });
    try {
      const r = await dev.fetch('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email: 'Dev@stjbs.sch.id' }) });
      expect(r.status).toBe(200);
      const token = pair(r, '__Host-dmc_session')!.split('=')[1]!;
      const me = await (await dev.fetch('/api/me', { as: token })).json() as { account: { email: string }; status: { member: boolean } };
      expect(me.account.email).toBe('dev@stjbs.sch.id');
      expect(me.status.member).toBe(true);
    } finally { await dev.dispose(); }
    const noFlag = await startWorker({ ENVIRONMENT: 'local' });
    try {
      expect((await noFlag.fetch('/api/auth/dev', { method: 'POST', body: JSON.stringify({ email: 'dev@x.com' }) })).status).toBe(404);
    } finally { await noFlag.dispose(); }
  }, 60_000);

  it('returns 503 JSON when sign-in is not configured', async () => {
    const [a, b] = await Promise.all([startWorker({ SESSION_SECRET: '' }), startWorker({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })]);
    try {
      for (const w of [a, b]) {
        const r = await w.fetch('/api/auth/google', { redirect: 'manual' } as RequestInit);
        expect(r.status).toBe(503);
        expect(r.headers.get('content-type')).toContain('application/json');
        expect(((await r.json()) as { error: string }).error).toMatch(/not configured/i);
      }
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
  }, 60_000);
});
