// POST /.netlify/functions/submit-score
// Body: {packId, packVersion, nickname, correct, total, durationMs, clientId, mode}
// Accepts only full-length exam-mode runs with plausible numbers, then inserts into Supabase.
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, optional ALLOWED_PACKS="id" or "id:total", comma separated.

const PACK_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CLIENT_ID = /^[A-Za-z0-9-]{8,64}$/;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Returns the row to insert, or a string saying what is wrong.
export function check(body, allowedPacks = '') {
  if (!body || typeof body !== 'object') return 'body must be a JSON object';
  const { packId, packVersion, correct, total, durationMs, clientId, mode } = body;
  const nickname = typeof body.nickname === 'string' ? body.nickname.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim() : '';
  if (mode !== 'exam') return 'only exam-mode runs are ranked';
  if (typeof packId !== 'string' || !PACK_ID.test(packId)) return 'bad packId';
  if (typeof packVersion !== 'string' || !packVersion || packVersion.length > 32) return 'bad packVersion';
  if (nickname.length < 2 || nickname.length > 20) return 'nickname must be 2-20 characters';
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) return 'bad clientId';
  if (!Number.isInteger(total) || total < 1 || total > 200) return 'total must be 1-200';
  if (!Number.isInteger(correct) || correct < 0 || correct > total) return 'correct must be 0-total';
  if (!Number.isInteger(durationMs) || durationMs < 2000 * total || durationMs > 24 * 3600 * 1000) return 'duration is not plausible';
  if (allowedPacks.trim()) {
    const allowed = new Map(allowedPacks.split(',').map((s) => s.trim().split(':')).map(([id, n]) => [id, n ? Number(n) : null]));
    if (!allowed.has(packId)) return 'this pack is not ranked';
    if (allowed.get(packId) !== null && allowed.get(packId) !== total) return 'only full-length runs are ranked';
  }
  return { pack_id: packId, pack_version: packVersion, nickname, correct, total, duration_ms: durationMs, client_id: clientId };
}

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'use POST' });
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ALLOWED_PACKS = '' } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return json(503, { error: 'leaderboard is not configured' });
  const text = await req.text();
  if (text.length > 2000) return json(413, { error: 'body too large' });
  let body;
  try { body = JSON.parse(text); } catch { return json(400, { error: 'body must be JSON' }); }
  const row = check(body, ALLOWED_PACKS);
  if (typeof row === 'string') return json(400, { error: row });
  const res = await fetch(`${SUPABASE_URL}/rest/v1/scores`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_KEY, authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json', prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  }).catch(() => null);
  if (!res?.ok) return json(502, { error: 'could not save the score' });
  return json(201, { ok: true });
};
