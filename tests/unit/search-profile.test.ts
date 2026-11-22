import { describe, expect, it } from 'vitest';
import { buildLocalIndex, searchLocal } from '../../src/lib/search';
import { initials, parseSubjects } from '../../src/screens/profile';
import type { Pack, Paper } from '../../src/lib/types';

const pack = (id: string, title: string, subject = '', description = '') => ({ id, title, subject, description }) as unknown as Pack;
const paper = (packId: string, key: string, title: string, questions: unknown[] = [], extra: object = {}) =>
  ({ packId, key, title, group: [], questions, ...extra }) as unknown as Paper;

describe('buildLocalIndex', () => {
  const packs = [pack('p1', 'Physics 9702', 'Physics')];
  const papers = [
    paper('p1', 'k1', 'Paper 12', [
      { n: 1, stem: 'Calculate the Mass', options: [{ text: 'Élan' }, { text: 'b' }] },
      { n: 2, stem: '  ', options: [] },
      { n: 3 },
    ]),
    paper('missing', 'k2', 'Orphan', [{ n: 1, stem: 'x' }]),
  ];

  it('makes set, paper and question items, skipping unknown packs and empty questions', () => {
    const idx = buildLocalIndex(packs, papers);
    expect(idx.map((i) => i.kind)).toEqual(['set', 'paper', 'question']);
    expect(idx.find((i) => i.title === 'Orphan')).toBeUndefined();
    expect(idx[2]!.id).toBe('k1#1');
  });

  it('lower-cases and strips diacritics', () => {
    const q = buildLocalIndex(packs, papers)[2]!;
    expect(q.text).toBe('calculate the mass elan b');
  });

  it('cuts question text to 400 characters', () => {
    const long = paper('p1', 'k3', 'Long', [{ n: 1, stem: 'a'.repeat(500) }]);
    const q = buildLocalIndex(packs, [long]).find((i) => i.kind === 'question')!;
    expect(q.text).toHaveLength(400);
  });
});

describe('searchLocal', () => {
  const packs = [pack('p1', 'Forces', 'Physics', 'about momentum'), pack('p2', 'Other', 'Misc')];
  const papers = [
    paper('p1', 'k1', 'Forces paper', [{ n: 1, stem: 'The mass of a+b( object', options: [] }]),
    paper('p2', 'k2', 'Momentum drill'),
  ];
  const idx = buildLocalIndex(packs, papers);

  it('prefix-matches words only at word start', () => {
    expect(searchLocal(idx, 'mas').some((i) => i.kind === 'question')).toBe(true);
    expect(searchLocal(idx, 'ass')).toEqual([]);
  });

  it('ANDs multiple words', () => {
    expect(searchLocal(idx, 'mass object')).toHaveLength(1);
    expect(searchLocal(idx, 'mass momentum')).toEqual([]);
  });

  it('returns [] for empty or punctuation-only queries', () => {
    expect(searchLocal(idx, '')).toEqual([]);
    expect(searchLocal(idx, '   ')).toEqual([]);
    expect(searchLocal(idx, '!?-+')).toEqual([]);
  });

  it('ranks title matches before text-only matches', () => {
    const r = searchLocal(idx, 'momentum');
    expect(r.map((i) => i.id)).toEqual(['k2', 'p1']); // paper title match beats set matching in description only
  });

  it('ranks sets before papers before questions on ties', () => {
    const i2 = buildLocalIndex([pack('p1', 'Forces')], [paper('p1', 'k1', 'Forces', [{ n: 1, stem: 'forces' }])]);
    expect(searchLocal(i2, 'forces').map((i) => i.kind)).toEqual(['set', 'paper', 'question']);
  });

  it('respects the limit', () => {
    expect(searchLocal(idx, 'forces', 1)).toHaveLength(1);
    expect(searchLocal(idx, 'forces', 0)).toEqual([]);
  });

  it('does not throw on regex special characters', () => {
    expect(() => searchLocal(idx, 'a+b(')).not.toThrow();
    expect(() => searchLocal(idx, '.*[')).not.toThrow();
    expect(searchLocal(idx, 'a+b(').length).toBeGreaterThan(0);
  });
});

describe('profile helpers', () => {
  it('initials', () => {
    expect(initials('Josef Yang')).toBe('JY');
    expect(initials('ana')).toBe('A');
    expect(initials('')).toBe('?');
    expect(initials('   ')).toBe('?');
    expect(initials('anna maria lopez')).toBe('AM');
  });

  it('parseSubjects', () => {
    expect(parseSubjects('Physics, chemistry ,, Physics')).toEqual(['Physics', 'chemistry']);
    expect(parseSubjects('  Further   Maths  ')).toEqual(['Further Maths']);
    expect(parseSubjects('')).toEqual([]);
    expect(parseSubjects('1,2,3,4,5,6,7,8,9,10')).toHaveLength(8);
    expect(parseSubjects('x'.repeat(60))[0]).toHaveLength(40);
  });
});
