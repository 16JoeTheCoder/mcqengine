// Results screen: score, this session's (or all-time) mistakes, explanation dialog with cause tags.
import { el, question, snapshot } from './render.js';
import { setRich } from './text.js';
import { CAUSES, mistakeKey } from './store.js';
import { setupBoard } from './leaderboard.js';

const $ = (id) => document.getElementById(id);
const REASONS = { manual: 'ended by you', timer: 'time ran out', complete: 'all questions answered' };
const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`; };
let ctx = null;

// c: {result, pack, store, show, onRetry(ids), onAgain(), onHome()}
export function showResults(c) {
  ctx = c;
  const { result, pack, store } = c;
  const pct = result.total ? Math.round((result.correct / result.total) * 100) : 0;
  $('score').textContent = `${result.correct} out of ${result.total} (${pct}%) in ${fmt(result.durationMs)}, ${REASONS[result.reason]}.`;
  const retryIds = store.mistakesFor(pack.id).map((m) => m.qid); // most-repeated first
  $('retry-btn').disabled = !retryIds.length;
  $('retry-btn').onclick = () => c.onRetry(retryIds);
  $('again-btn').onclick = () => c.onAgain();
  $('home-btn').onclick = () => c.onHome();
  $('alltime').checked = false;
  $('alltime').onchange = drawMistakes;
  drawMistakes();
  c.show('results');
  setupBoard(result, store);
}

function drawMistakes() {
  const { result, pack, store } = ctx;
  const all = $('alltime').checked;
  const list = all ? store.mistakesFor(pack.id)
    : result.items.filter((i) => !i.correct).map((i) => ({ qid: i.id, selected: i.selected, rev: i.rev }));
  const byId = new Map(pack.questions.map((q) => [q.id, q]));
  $('mistakes').replaceChildren(...list.map((m) => item(byId.get(m.qid), m, all)));
  if (!list.length) $('mistakes').append(el('li', { className: 'meta' }, all ? 'No mistakes recorded for this pack.' : 'No mistakes this time.'));
}

function item(q, m, all) {
  if (!q) return el('li', { className: 'card' }, `Question ${m.qid} is no longer in this pack.`);
  const label = `Question ${q.number ?? q.id}`;
  const explain = q.explanation
    ? el('button', { onclick: () => openExplain(q) }, 'Explain the answer')
    : el('p', { className: 'meta' }, 'No explanation yet.');
  if (q.explanation) explain.setAttribute('aria-label', `Explain the answer to ${label}`);
  return el('li', { className: 'card mistake' },
    el('h3', {}, label),
    question(ctx.pack, q),
    el('p', { className: 'answers' },
      el('span', { className: 'yours' }, m.selected === null ? 'Not answered' : `Your answer: ${m.selected}`),
      el('span', { className: 'correct' }, `Correct: ${q.answer}`)),
    q.rev !== m.rev && el('p', { className: 'changed' }, 'Question changed since you answered.'),
    all && el('p', { className: 'meta' }, `Wrong ${m.timesWrong} time${m.timesWrong > 1 ? 's' : ''}${m.cause ? `, tagged ${m.cause}` : ''}.`),
    explain);
}

function openExplain(q) {
  const { pack, store } = ctx;
  $('explain-h').textContent = `Question ${q.number ?? q.id}: the answer is ${q.answer}`;
  setRich($('explain-body'), q.explanation);
  const drawCauses = () => {
    const current = store.data.mistakes[mistakeKey(pack.id, q.id)]?.cause || '';
    $('cause-buttons').replaceChildren(...CAUSES.map((cause) => {
      const b = el('button', { type: 'button', onclick: () => { store.setCause(pack.id, q.id, cause); drawCauses(); drawMistakes(); } }, cause);
      b.setAttribute('aria-pressed', String(cause === current));
      return b;
    }));
  };
  drawCauses();
  $('explain-original').replaceChildren(q.snapshot?.length
    ? el('details', { className: 'original' }, el('summary', {}, 'View original'), snapshot(pack, q)) : '');
  $('explain').showModal();
}
