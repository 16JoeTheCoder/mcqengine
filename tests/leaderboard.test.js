// Netlify functions against a mocked Supabase REST API.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import submit, { check } from '../netlify/functions/submit-score.js';
import leaderboard from '../netlify/functions/leaderboard.js';

let calls = [];
let reply = () => new Response(null, { status: 201 });
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return reply(url, init); };

beforeEach(() => {
  calls = [];
  reply = () => new Response(null, { status: 201 });
  Object.assign(process.env, { SUPABASE_URL: 'https://db.example', SUPABASE_SERVICE_KEY: 'secret' });
  delete process.env.ALLOWED_PACKS;
});

const good = { packId: 'sample-physics', packVersion: '1.0.0', nickname: '  Ada\u0007 ', correct: 7, total: 8, durationMs: 60000, clientId: 'abcd-1234-efgh', mode: 'exam' };
const post = (body) => submit(new Request('http://x/.netlify/functions/submit-score', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }));

test('valid exam run is inserted with the service key', async () => {
  const res = await post(good);
  assert.equal(res.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://db.example/rest/v1/scores');
  assert.equal(calls[0].init.headers.authorization, 'Bearer secret');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    pack_id: 'sample-physics', pack_version: '1.0.0', nickname: 'Ada', correct: 7, total: 8, duration_ms: 60000, client_id: 'abcd-1234-efgh',
  });
});

test('rejections', async () => {
  const cases = [
    [{ mode: 'practice' }, /exam-mode/], [{ correct: 9 }, /correct/], [{ total: 0, correct: 0 }, /total/],
    [{ total: 201, correct: 1, durationMs: 1e7 }, /total/], [{ durationMs: 15999 }, /duration/], [{ nickname: ' a\u0000 ' }, /nickname/],
    [{ nickname: 'x'.repeat(21) }, /nickname/], [{ packId: '../etc' }, /packId/], [{ clientId: 'no' }, /clientId/], [{ correct: 1.5 }, /correct/],
  ];
  for (const [patch, why] of cases) {
    const res = await post({ ...good, ...patch });
    assert.equal(res.status, 400, JSON.stringify(patch));
    assert.match((await res.json()).error, why);
  }
  assert.equal((await post('not json')).status, 400);
  assert.equal((await submit(new Request('http://x/', { method: 'GET' }))).status, 405);
  assert.equal(calls.length, 0);
});

test('ALLOWED_PACKS limits packs and enforces full length', () => {
  assert.equal(check(good, 'other'), 'this pack is not ranked');
  assert.equal(check(good, 'sample-physics:40'), 'only full-length runs are ranked');
  assert.equal(typeof check(good, 'other, sample-physics:8'), 'object');
  assert.equal(typeof check(good, 'sample-physics'), 'object');
});

test('missing configuration and database failure', async () => {
  delete process.env.SUPABASE_URL;
  assert.equal((await post(good)).status, 503);
  process.env.SUPABASE_URL = 'https://db.example';
  reply = () => new Response('{}', { status: 500 });
  assert.equal((await post(good)).status, 502);
  reply = () => { throw new Error('network'); };
  assert.equal((await post(good)).status, 502);
});

test('leaderboard reads the best_scores view and maps rows', async () => {
  reply = () => Response.json([{ nickname: 'Ada', correct: 8, total: 8, duration_ms: 50000, created_at: 't' }]);
  const res = await leaderboard(new Request('http://x/.netlify/functions/leaderboard?pack=sample-physics'));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=30/);
  assert.deepEqual(await res.json(), { pack: 'sample-physics', scores: [{ nickname: 'Ada', correct: 8, total: 8, durationMs: 50000, at: 't' }] });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/rest/v1/best_scores');
  assert.equal(url.searchParams.get('pack_id'), 'eq.sample-physics');
  assert.equal(url.searchParams.get('order'), 'correct.desc,duration_ms.asc,created_at.asc');
  assert.equal(url.searchParams.get('limit'), '50');
});

test('leaderboard rejects bad ids and reports missing configuration', async () => {
  assert.equal((await leaderboard(new Request('http://x/?pack=Bad%20Id'))).status, 400);
  delete process.env.SUPABASE_SERVICE_KEY;
  assert.equal((await leaderboard(new Request('http://x/?pack=ok-id'))).status, 503);
  assert.equal(calls.length, 0);
});
