// Optional global leaderboard. Shown only when /.netlify/functions/leaderboard answers; otherwise hidden.
import { el } from './render.js';

const BASE = '/.netlify/functions/';
const $ = (id) => document.getElementById(id);

async function call(path, options) {
  const r = await fetch(BASE + path, { ...options, signal: AbortSignal.timeout(6000) });
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error(data?.error || `server answered ${r.status}`);
  return data;
}

const time = (ms) => `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;

function draw(scores) {
  $('board-list').replaceChildren(...scores.map((s) =>
    el('li', {}, el('strong', {}, s.nickname), ` ${s.correct}/${s.total} in ${time(s.durationMs)}`)));
  if (!scores.length) $('board-list').append(el('li', { className: 'meta' }, 'No scores yet.'));
}

export function setupBoard(result, store) {
  $('board').hidden = true;
  const query = `leaderboard?pack=${encodeURIComponent(result.packId)}`;
  call(query).then((data) => {
    if (!Array.isArray(data?.scores)) return;
    $('board').hidden = false;
    $('board-msg').textContent = '';
    draw(data.scores);
    const form = $('post-form');
    form.hidden = !(result.mode === 'exam' && result.full);
    $('nickname').value = store.data.nickname;
    form.onsubmit = async (e) => {
      e.preventDefault();
      const nickname = $('nickname').value.trim();
      store.update((d) => { d.nickname = nickname; });
      try {
        await call('submit-score', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            packId: result.packId, packVersion: result.packVersion, nickname, correct: result.correct,
            total: result.total, durationMs: result.durationMs, clientId: store.data.clientId, mode: result.mode,
          }),
        });
        form.hidden = true;
        $('board-msg').textContent = 'Score posted.';
        draw((await call(query)).scores);
      } catch (err) {
        $('board-msg').textContent = `Could not post the score: ${err.message}`;
      }
    };
  }).catch(() => { /* no backend: the feature stays hidden */ });
}
