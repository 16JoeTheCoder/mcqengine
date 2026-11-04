import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createSupabaseBackend } from '../../src/lib/backend/supabase';
const auth = vi.hoisted(() => ({ getSession: vi.fn(), signInWithOtp: vi.fn(), verifyOtp: vi.fn(), signOut: vi.fn() }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth }) }));
const session = (id: string) => ({ data: { session: { user: { id }, access_token: `test-token-${id}` } }, error: null });
beforeEach(() => { vi.clearAllMocks(); auth.getSession.mockResolvedValue(session('A')); });
afterEach(() => vi.unstubAllGlobals());

it('uses Supabase email code request and verify APIs without a provider chooser', async () => {
  auth.signInWithOtp.mockResolvedValue({ data:{},error:null });
  auth.verifyOtp.mockResolvedValue({ data:{},error:null });
  const backend = createSupabaseBackend('https://test.supabase.co','public-key');
  await backend.signInEmail(' student@example.com ');
  expect(auth.signInWithOtp).toHaveBeenCalledWith({email:'student@example.com',options:expect.objectContaining({shouldCreateUser:true})});
  await backend.verifyEmailCode('Student@example.com',' 123456 ');
  expect(auth.verifyOtp).toHaveBeenCalledWith({email:'student@example.com',token:'123456',type:'email'});
  auth.verifyOtp.mockResolvedValue({ data:{},error:{message:'Token expired'} });
  await expect(backend.verifyEmailCode('student@example.com','000000')).rejects.toThrow('Token expired');
});

it('refuses an in-flight account A RPC when the session resolves to account B', async () => {
  let release!: (value: ReturnType<typeof session>) => void;
  auth.getSession.mockReturnValue(new Promise(resolve => { release = resolve; }));
  const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher);
  const backend = createSupabaseBackend('https://test.supabase.co','public-key');
  const pending = backend.syncPush([], 'A');
  await vi.waitFor(() => expect(auth.getSession).toHaveBeenCalled());
  release(session('B'));
  await expect(pending).rejects.toThrow('Account changed');
  expect(fetcher).not.toHaveBeenCalled();
});

it('fixes the outgoing sync bearer to the expected account and never caches API responses', async () => {
  const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
    auth.getSession.mockResolvedValue(session('B'));
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer test-token-A');
    expect(options.cache).toBe('no-store');
    return new Response('0',{headers:{'content-type':'application/json'}});
  });
  vi.stubGlobal('fetch',fetcher);
  const backend = createSupabaseBackend('https://test.supabase.co','public-key');
  expect(await backend.syncPush([], 'A')).toBe(0);
  await expect(backend.syncPull(null,500,'A')).rejects.toThrow('Account changed');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
