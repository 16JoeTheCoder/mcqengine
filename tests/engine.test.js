import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../js/engine.js';

const pack = {
  id: 'p', version: '1', optionKeys: ['A', 'B', 'C', 'D'], timeLimitSec: 30,
  questions: [
    { id: 'q1', type: 'single', rev: 1, answer: 'A' },
    { id: 'q2', type: 'single', rev: 1, answer: 'B' },
    { id: 'q3', type: 'future', rev: 1 },
    { id: 'q4', type: 'single', rev: 2, answer: 'C' },
  ],
};

function setup(opts) {
  let t = 1000;
  const clock = { advance: (ms) => { t += ms; } };
  const engine = createEngine({ now: () => t, random: () => 0 });
  const events = [];
  for (const e of ['question', 'answered', 'tick', 'ended']) engine.on(e, (d) => events.push([e, d]));
  engine.start(pack, opts);
  return { engine, clock, events, ended: () => events.find(([e]) => e === 'ended')?.[1] };
}

test('exam: answering every question ends with reason complete; unsupported type is not scored', () => {
  const { engine, ended } = setup({ mode: 'exam' });
  assert.equal(engine.status, 'running');
  engine.answer('q1', 'A');
  engine.answer('q1', 'D'); // exam mode allows changing
  engine.answer('q1', 'A');
  engine.answer('q2', 'C');
  assert.equal(engine.answer('q3', 'A'), false);
  engine.answer('q4', 'C');
  const r = ended();
  assert.equal(r.reason, 'complete');
  assert.equal(r.total, 3);
  assert.equal(r.correct, 2);
  assert.deepEqual(r.items.map((i) => i.selected), ['A', 'C', 'C']);
  assert.equal(engine.status, 'ended');
  assert.equal(engine.answer('q1', 'B'), false);
});

test('exam: a flagged question holds off the automatic end', () => {
  const { engine, ended } = setup({ mode: 'exam' });
  engine.flag('q2');
  for (const [id, k] of [['q1', 'A'], ['q2', 'B'], ['q4', 'C']]) engine.answer(id, k);
  assert.equal(ended(), undefined);
  engine.flag('q2');
  engine.answer('q2', 'B');
  assert.equal(ended().reason, 'complete');
});

test('manual end counts unanswered as wrong with selected null', () => {
  const { engine, clock, ended } = setup({ mode: 'exam' });
  engine.answer('q1', 'A');
  clock.advance(5000);
  engine.end('manual');
  const r = ended();
  assert.equal(r.reason, 'manual');
  assert.equal(r.correct, 1);
  assert.deepEqual(r.items.filter((i) => !i.correct).map((i) => [i.id, i.selected]), [['q2', null], ['q4', null]]);
  assert.equal(r.durationMs, 5000);
  assert.equal(engine.end('manual'), null);
});

test('timer: ticks report remaining time and reaching zero ends with reason timer', () => {
  const { engine, clock, events, ended } = setup({ mode: 'exam' });
  clock.advance(10_000);
  engine.tick();
  assert.equal(events.at(-1)[1].remainingMs, 20_000);
  clock.advance(1_000_000); // a sleeping tab: one huge delta, still capped at the limit
  engine.tick();
  assert.equal(ended().reason, 'timer');
  assert.equal(ended().durationMs, 30_000);
});

test('timer: clock going backwards never adds time', () => {
  const { engine, clock } = setup({ mode: 'exam' });
  clock.advance(-50_000);
  engine.tick();
  assert.equal(engine.state.elapsedMs, 0);
});

test('practice: no timer, first answer locks, feedback is immediate', () => {
  const { engine, clock, events, ended } = setup({ mode: 'practice' });
  assert.equal(engine.state.limitMs, 0);
  assert.equal(engine.answer('q1', 'B'), true);
  assert.deepEqual(events.at(-1), ['answered', { questionId: 'q1', key: 'B', correct: false }]);
  assert.equal(engine.answer('q1', 'A'), false);
  clock.advance(99_999_999);
  engine.tick();
  assert.equal(engine.status, 'running');
  engine.answer('q2', 'B');
  engine.answer('q4', 'C');
  assert.equal(ended().reason, 'complete');
  assert.equal(ended().correct, 2);
});

test('retry subset keeps the given order and is not full length', () => {
  const { engine, ended } = setup({ mode: 'practice', ids: ['q4', 'missing', 'q1'] });
  assert.deepEqual(engine.state.order, ['q4', 'q1']);
  engine.answer('q4', 'C');
  engine.answer('q1', 'A');
  assert.equal(ended().full, false);
  assert.equal(ended().total, 2);
});

test('shuffle reorders questions only; goto clamps and emits question', () => {
  const { engine, events } = setup({ mode: 'exam', shuffle: true });
  assert.deepEqual(engine.state.order, ['q2', 'q3', 'q4', 'q1']);
  engine.goto(99);
  assert.equal(events.at(-1)[1].question.id, 'q1');
  assert.equal(engine.state.index, 3);
});

test('snapshot and resume restore answers, flags and elapsed time', () => {
  const a = setup({ mode: 'exam' });
  a.engine.answer('q1', 'A');
  a.engine.flag('q2');
  a.clock.advance(4000);
  a.engine.tick();
  const snap = a.engine.snapshot();
  const b = setup({ mode: 'exam', resume: snap });
  assert.deepEqual(b.engine.state.answers, { q1: 'A' });
  assert.deepEqual(b.engine.state.flags, ['q2']);
  assert.equal(b.engine.state.elapsedMs, 4000);
});
