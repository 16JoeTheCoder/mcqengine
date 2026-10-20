// Screen routing and wiring: home (packs, uploads, data), play, results.
import { createEngine } from './engine.js';
import { createStore, putPack, listPacks, deletePack } from './store.js';
import { loadIndex, loadBuiltin, readUpload, fromBytes, attachBlobs, closePack } from './importer.js';
import { el, question, answerButtons } from './render.js';
import { setRich } from './text.js';
import { showResults } from './review.js';

const $ = (id) => document.getElementById(id);
const storage = (() => { try { return globalThis.localStorage; } catch { return null; } })();
const store = createStore(storage);
const engine = createEngine();
const MILESTONES = [600, 300, 60]; // seconds remaining that get announced
let pack = null, ref = null, timer = 0, announced = new Set();

function show(id) {
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== id;
  $(id).querySelector('h1')?.setAttribute('tabindex', '-1');
  $(id).querySelector('h1')?.focus();
}

function notice(msg) {
  $('notice').hidden = !msg;
  $('notice').textContent = msg || '';
}

const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---- loading packs. ref: {kind: 'builtin', dir} or {kind: 'upload', id}

async function load(r) {
  let result;
  if (r.kind === 'builtin') {
    result = await loadBuiltin(r);
  } else {
    const rec = (await listPacks()).find((p) => p.id === r.id);
    if (!rec) throw new Error('That pack is no longer stored in this browser.');
    result = await fromRecord(rec);
  }
  if (result.errors.length) throw new Error(result.errors.map((e) => `${e.where}: ${e.message}`).join('\n'));
  if (pack && pack !== result.pack) closePack(pack);
  return result.pack;
}

async function fromRecord(rec) {
  const raw = new Map([['pack.json', new TextEncoder().encode(rec.json)]]);
  for (const [path, blob] of Object.entries(rec.assets)) raw.set(path, new Uint8Array(await blob.arrayBuffer()));
  const result = fromBytes(raw);
  if (result.pack) attachBlobs(result.pack, result.blobs);
  return result;
}

// ---- home

async function home() {
  clearInterval(timer);
  show('home');
  notice(store.notice);
  const { settings, active } = store.data;
  for (const r of document.querySelectorAll('input[name=mode]')) r.checked = r.value === settings.mode;
  $('shuffle').checked = settings.shuffle;
  $('resume').hidden = !active;
  if (active) $('resume-text').textContent = `Unfinished ${active.snapshot.mode} session: ${active.title}, ${Object.keys(active.snapshot.answers).length} answered.`;
  const builtin = await loadIndex().catch(() => []);
  const uploaded = await listPacks();
  $('pack-list').replaceChildren(
    ...builtin.map((p) => packItem(p.title, `${p.questions} questions · built in`, { kind: 'builtin', dir: p.dir })),
    ...uploaded.map((p) => packItem(p.title, `version ${p.version} · loaded by you`, { kind: 'upload', id: p.id }, p.id)),
  );
  if (!builtin.length && !uploaded.length) $('pack-list').append(el('li', {}, 'No packs yet. Load one below.'));
}

function packItem(title, meta, r, removableId) {
  const start = el('button', { className: 'primary', onclick: () => begin(r) }, 'Start');
  start.setAttribute('aria-label', `Start ${title}`);
  const remove = removableId && el('button', { onclick: async () => {
    if (confirm(`Remove "${title}" from this browser?`)) { await deletePack(removableId); home(); }
  } }, 'Remove');
  return el('li', { className: 'card' }, el('div', {}, el('strong', {}, title), el('p', { className: 'meta' }, meta)), el('div', { className: 'row' }, start, remove));
}

async function begin(r, opts = {}) {
  try {
    pack = await load(r);
  } catch (e) {
    return notice(`Could not open the pack. ${e.message}`);
  }
  ref = r;
  const { mode, shuffle } = store.data.settings;
  announced = new Set();
  engine.start(pack, { mode, shuffle, ...opts });
  show('play');
  clearInterval(timer);
  timer = setInterval(() => engine.tick(), 250);
  engine.tick();
  autosave();
}

function autosave() {
  if (engine.status === 'running' && ref && engine.state.full) {
    store.update((d) => { d.active = { ref, title: pack.title, snapshot: engine.snapshot() }; });
  }
}

// ---- play

engine.on('question', ({ question: q }) => {
  const st = engine.state;
  $('play-h').textContent = `Question ${st.index + 1} of ${st.order.length}`;
  $('q-area').replaceChildren(question(pack, q));
  $('options').replaceChildren(...answerButtons(pack, q));
  $('feedback').replaceChildren();
  $('prev-btn').disabled = st.index === 0;
  $('next-btn').textContent = st.index === st.order.length - 1 ? 'Finish' : 'Next →';
  $('flag-btn').hidden = st.mode !== 'exam';
  drawState();
  if (st.mode === 'practice' && q.id in st.answers) reveal(q, st.answers[q.id]);
});

function drawState() {
  const st = engine.state;
  const q = st.questions[st.index];
  for (const b of $('options').children) b.setAttribute('aria-pressed', String(st.answers[q.id] === b.value));
  $('flag-btn').setAttribute('aria-pressed', String(st.flags.includes(q.id)));
  $('palette').hidden = st.mode !== 'exam';
  if (st.mode !== 'exam') return;
  $('palette').replaceChildren(...st.questions.map((x, i) => {
    const state = [x.id in st.answers ? 'answered' : 'unanswered', st.flags.includes(x.id) && 'flagged'].filter(Boolean);
    const b = el('button', { className: state.join(' '), onclick: () => engine.goto(i) }, String(i + 1));
    b.setAttribute('aria-label', `Question ${i + 1}, ${state.join(', ')}`);
    if (i === st.index) b.setAttribute('aria-current', 'step');
    return b;
  }));
}

function reveal(q, key) {
  for (const b of $('options').children) {
    b.disabled = true;
    b.classList.toggle('right', b.value === q.answer);
    b.classList.toggle('wrong', b.value === key && key !== q.answer);
  }
  const ok = key === q.answer;
  const box = el('div', { className: ok ? 'good' : 'bad' }, el('p', {}, el('strong', {}, ok ? 'Correct.' : `Not quite: the answer is ${q.answer}.`)));
  box.append(q.explanation ? setRich(el('div'), q.explanation) : el('p', { className: 'meta' }, 'No explanation yet.'));
  $('feedback').replaceChildren(box);
}

engine.on('answered', ({ key }) => {
  const st = engine.state;
  autosave();
  drawState();
  if (st.mode === 'practice') reveal(st.questions[st.index], key);
  else $('live').textContent = `Answered ${key}. ${Object.keys(st.answers).length} of ${st.order.length} answered.`;
});

engine.on('tick', ({ elapsedMs, remainingMs }) => {
  $('timer').textContent = remainingMs === null ? `Time ${fmt(elapsedMs)}` : `${fmt(remainingMs)} left`;
  const left = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  for (const m of MILESTONES) {
    if (left !== null && left <= m && left > 0 && !announced.has(m)) {
      announced.add(m);
      $('live').textContent = `${m / 60} minute${m === 60 ? '' : 's'} left.`;
    }
  }
  if (Math.round(elapsedMs / 250) % 20 === 0) autosave(); // keep elapsed time roughly current
});

engine.on('ended', (result) => {
  clearInterval(timer);
  store.recordResult(result);
  showResults({ result, pack, store, show, onRetry: (ids) => begin(ref, { mode: 'practice', shuffle: false, ids }), onAgain: () => begin(ref), onHome: home });
});

$('options').addEventListener('click', (e) => {
  const b = e.target.closest('button.option');
  if (b) engine.answer(engine.state.questions[engine.state.index].id, b.value);
});
$('prev-btn').onclick = () => engine.goto(engine.state.index - 1);
$('next-btn').onclick = () => {
  const st = engine.state;
  if (st.index < st.order.length - 1) return engine.goto(st.index + 1);
  if (confirm('End the session now and see your results?')) engine.end('manual');
};
$('flag-btn').onclick = () => { engine.flag(engine.state.questions[engine.state.index].id); autosave(); drawState(); };
$('end-btn').onclick = () => { if (confirm('End the session now? Unanswered questions count as wrong.')) engine.end('manual'); };

document.addEventListener('keydown', (e) => {
  if ($('play').hidden || engine.status !== 'running' || $('explain').open || e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.target.closest('input, textarea, select, summary')) return;
  const keys = pack.optionKeys;
  const k = /^[1-9]$/.test(e.key) ? keys[Number(e.key) - 1] : keys.find((x) => x.toLowerCase() === e.key.toLowerCase());
  if (k) engine.answer(engine.state.questions[engine.state.index].id, k);
  else if (e.key === 'ArrowLeft') engine.goto(engine.state.index - 1);
  else if (e.key === 'ArrowRight') engine.goto(engine.state.index + 1);
  else if (e.key === 'Enter' && !e.target.closest('button, a')) $('next-btn').click();
  else return;
  e.preventDefault();
});

addEventListener('pagehide', autosave);
document.addEventListener('visibilitychange', () => { engine.tick(); autosave(); });

// ---- home controls

for (const r of document.querySelectorAll('input[name=mode]')) r.onchange = () => store.update((d) => { d.settings.mode = r.value; });
$('shuffle').onchange = (e) => store.update((d) => { d.settings.shuffle = e.target.checked; });
$('resume-btn').onclick = async () => {
  const { ref: r, snapshot } = store.data.active;
  await begin(r, { mode: snapshot.mode, resume: snapshot });
};
$('discard-btn').onclick = () => { store.update((d) => { d.active = null; }); home(); };

for (const id of ['up-zip', 'up-dir', 'up-json']) {
  $(id).onchange = async (e) => {
    const msg = $('upload-msg');
    msg.replaceChildren('Checking pack…');
    try {
      const { pack: p, errors, warnings, json, blobs } = fromBytes(await readUpload(e.target.files));
      if (errors.length) {
        msg.replaceChildren(el('p', {}, `This pack was refused (${errors.length} problem${errors.length > 1 ? 's' : ''}):`),
          el('ul', {}, errors.map((x) => el('li', {}, `${x.where === 'pack' ? 'Pack' : `Question ${x.where}`}: ${x.message}`))));
        return;
      }
      const saved = await putPack({ id: p.id, title: p.title, version: p.version, json, assets: Object.fromEntries(blobs) });
      msg.replaceChildren(`Loaded "${p.title}".` + (saved ? '' : ' It could not be saved and will be gone after you close this page.')
        + (warnings.length ? ` ${warnings.length} warning(s): ${warnings.map((w) => w.message).join('; ')}` : ''));
      await home();
    } catch (err) {
      msg.replaceChildren(`Could not read that file: ${err.message}`);
    } finally {
      e.target.value = '';
    }
  };
}

$('export-btn').onclick = () => {
  const url = URL.createObjectURL(new Blob([store.exportJSON()], { type: 'application/json' }));
  el('a', { href: url, download: `mcq-data-${new Date().toISOString().slice(0, 10)}.json` }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
$('import-file').onchange = async (e) => {
  try {
    store.importJSON(await e.target.files[0].text());
    $('data-msg').textContent = 'Data imported.';
    home();
  } catch (err) {
    $('data-msg').textContent = `Import failed: ${err.message}`;
  } finally {
    e.target.value = '';
  }
};

home();
