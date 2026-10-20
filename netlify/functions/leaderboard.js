// GET /.netlify/functions/leaderboard?pack=<id>
// Best result per client for a pack, by correct desc then duration asc, top 50.
// Reads the best_scores view (docs/leaderboard.sql). Env: SUPABASE_URL, SUPABASE_SERVICE_KEY.

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const json = (status, body, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': cache } });

export default async (req) => {
  if (req.method !== 'GET') return json(405, { error: 'use GET' });
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(503, { error: 'leaderboard is not configured' });
  const pack = new URL(req.url).searchParams.get('pack') || '';
  if (!PACK_ID.test(pack)) return json(400, { error: 'bad pack id' });
  const query = new URLSearchParams({
    select: 'nickname,correct,total,duration_ms,created_at', pack_id: `eq.${pack}`,
    order: 'correct.desc,duration_ms.asc,created_at.asc', limit: '50',
  });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/best_scores?${query}`, {
    headers: { apikey: SUPABASE_SERVICE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_KEY}` },
  }).catch(() => null);
  if (!res?.ok) return json(502, { error: 'could not read scores' });
  const rows = await res.json();
  const scores = rows.map((r) => ({ nickname: r.nickname, correct: r.correct, total: r.total, durationMs: r.duration_ms, at: r.created_at }));
  return json(200, { pack, scores }, 'public, max-age=30, stale-while-revalidate=60');
};
