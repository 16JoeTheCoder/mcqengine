// Session state machine: idle -> running -> ended. No DOM, no storage.
// Events: question {index, question}, answered {questionId, key, correct}, tick {elapsedMs, remainingMs}, ended (result).
import { SUPPORTED_TYPES } from './validator.js';

const DEFAULT_SECONDS_PER_QUESTION = 90;
const scorable = (q) => SUPPORTED_TYPES.includes(q.type);

export function createEngine({ now = () => performance.now(), random = Math.random } = {}) {
  const listeners = {};
  let status = 'idle', pack = null, byId = new Map(), s = null, last = 0;

  const emit = (event, data) => (listeners[event] || []).forEach((fn) => fn(data));
  const questions = () => s.order.map((id) => byId.get(id));
  const remaining = () => (s.limitMs ? Math.max(0, s.limitMs - s.elapsedMs) : null);

  function accrue() {
    const t = now();
    s.elapsedMs += Math.max(0, t - last); // performance.now deltas: wall-clock changes cannot move the timer
    last = t;
  }

  function start(p, { mode = 'exam', shuffle = false, ids = null, resume = null } = {}) {
    pack = p;
    byId = new Map(p.questions.map((q) => [q.id, q]));
    const order = ids ? ids.filter((id) => byId.has(id)) : p.questions.map((q) => q.id);
    if (shuffle) {
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
    }
    const perQuestion = p.timeLimitSec ? p.timeLimitSec / p.questions.length : DEFAULT_SECONDS_PER_QUESTION;
    s = {
      packId: p.id, packVersion: p.version, mode, order, index: 0, answers: {}, flags: [], elapsedMs: 0,
      limitMs: mode === 'exam' ? Math.round(perQuestion * order.length * 1000) : 0, full: !ids,
    };
    if (resume) Object.assign(s, resume, { order: resume.order.filter((id) => byId.has(id)) });
    status = 'running';
    last = now();
    emit('question', { index: s.index, question: byId.get(s.order[s.index]) });
  }

  function answer(questionId, key) {
    const q = byId.get(questionId);
    if (status !== 'running' || !q || !s.order.includes(questionId) || !scorable(q) || !pack.optionKeys.includes(key)) return false;
    if (s.mode === 'practice' && questionId in s.answers) return false; // practice locks the first answer
    s.answers[questionId] = key;
    emit('answered', { questionId, key, correct: key === q.answer });
    const done = questions().filter(scorable).every((x) => x.id in s.answers);
    if (done && (s.mode === 'practice' || !s.flags.length)) end('complete'); // a flag means "let me come back"
    return true;
  }

  function flag(questionId) {
    if (status !== 'running' || !s.order.includes(questionId)) return;
    s.flags = s.flags.includes(questionId) ? s.flags.filter((id) => id !== questionId) : [...s.flags, questionId];
  }

  function goto(index) {
    if (status !== 'running') return;
    s.index = Math.min(Math.max(0, index), s.order.length - 1);
    emit('question', { index: s.index, question: byId.get(s.order[s.index]) });
  }

  function tick() {
    if (status !== 'running') return;
    accrue();
    emit('tick', { elapsedMs: s.elapsedMs, remainingMs: remaining() });
    if (s.limitMs && s.elapsedMs >= s.limitMs) end('timer');
  }

  function end(reason) {
    if (status !== 'running') return null;
    accrue();
    status = 'ended';
    const items = questions().filter(scorable).map((q) => {
      const selected = s.answers[q.id] ?? null; // unanswered counts as wrong
      return { id: q.id, rev: q.rev, selected, answer: q.answer, correct: selected === q.answer };
    });
    const result = {
      packId: s.packId, packVersion: s.packVersion, mode: s.mode, reason, full: s.full,
      correct: items.filter((i) => i.correct).length, total: items.length,
      durationMs: Math.round(s.limitMs ? Math.min(s.elapsedMs, s.limitMs) : s.elapsedMs), items,
    };
    emit('ended', result);
    return result;
  }

  return {
    start, answer, flag, goto, tick, end,
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    get status() { return status; },
    get state() { return s && { ...s, status, remainingMs: remaining(), questions: questions() }; },
    snapshot: () => s && JSON.parse(JSON.stringify(s)),
  };
}
