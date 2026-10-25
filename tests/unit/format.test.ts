import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { lenientParse } from '../../src/lib/format/lenient';
import { parseMarkup, markupToText } from '../../src/lib/format/markup';
import { sanitizeSvg } from '../../src/lib/format/svg';
import { parseKey, validateDoc } from '../../src/lib/format/validate';
import { mergeDoc, questionHash } from '../../src/lib/format/merge';
import { parseImport } from '../../src/lib/data/importer';
import { buildFixPrompt, buildPrompt, buildAnswersPrompt } from '../../src/lib/format/prompt';
import schema from '../../schema/dmc-pack-1.schema.json';
import { doc, syntheticPaper } from '../fixtures/make';

const ok = (text: string, files: string[] = []) => {
  const r = parseImport(text, new Set(files));
  if (!r.ok) throw new Error(r.syntax);
  return r.result;
};
const paths = (r: { errors: { path: string; message: string }[] }) => r.errors.map((e) => `${e.path}: ${e.message}`);

describe('tolerant intake', () => {
  const clean = JSON.stringify(doc(syntheticPaper('p1', 3)));
  it('accepts plain JSON with no notes', () => {
    const r = ok(clean);
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([]);
    expect(r.doc.papers[0]!.questions).toHaveLength(3);
  });
  it('strips markdown fences and surrounding prose', () => {
    const r = ok(`Sure! Here is the JSON:\n\n\`\`\`json\n${clean}\n\`\`\`\nLet me know if you need anything else.`);
    expect(r.errors).toEqual([]);
    expect(r.notes.join()).toMatch(/code fences/);
  });
  it('handles prose around unfenced JSON', () => {
    const r = ok(`Here you go: ${clean} Hope this helps.`);
    expect(r.errors).toEqual([]);
    expect(r.notes.join()).toMatch(/before the JSON/);
  });
  it('repairs trailing commas, smart quotes, comments and unquoted keys', () => {
    const text = `{ format: "dmc-pack/1", // comment
      “papers”: [{ "id": "p1", "title": "T", "questionCount": 1, "questions": [
        { "n": 1, "stem": "He said “hello”, didn’t he?", "options": ["a","b","c","d",], "answer": "b", },
      ], }], }`;
    const r = ok(text);
    expect(paths(r)).toEqual([]);
    expect(r.doc.papers[0]!.questions[0]!.stem).toBe('He said “hello”, didn’t he?');
    expect(r.doc.papers[0]!.questions[0]!.answer).toBe(1);
    expect(r.notes.join()).toMatch(/trailing commas/);
    expect(r.notes.join()).toMatch(/smart quotes/);
    expect(r.notes.join()).toMatch(/answer letters/);
  });
  it('keeps unescaped LaTeX backslashes and converts symbols', () => {
    const text = String.raw`{"papers":[{"id":"p","title":"T","questionCount":1,"questions":[{"n":1,"stem":"KE = \frac{1}{2}mv^{2}, wavelength \lambda, angle \theta, R = 5 \Omega","options":["a","b","c","d"],"answer":"A"}]}]}`;
    const r = ok(text);
    expect(paths(r)).toEqual([]);
    expect(r.doc.papers[0]!.questions[0]!.stem).toBe('KE = \\frac{1}{2}mv^{2}, wavelength λ, angle θ, R = 5 Ω');
  });
  it('accepts a bare paper object and alias names', () => {
    const r = ok(JSON.stringify({ ID: 'x', Title: 'X', question_count: 1, Questions: [{ number: '1', question: 'Q?', choices: ['A. one', 'B. two', 'C. three', 'D. four'], correct_answer: '(c)' }] }));
    expect(paths(r)).toEqual([]);
    const q = r.doc.papers[0]!.questions[0]!;
    expect(q.options!.map((o) => o.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(q.answer).toBe(2);
  });
  it('reports syntax errors with line numbers', () => {
    const r = parseImport('{\n "papers": [\n  { "id": "x" \n');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.syntax).toMatch(/line/);
  });
  it('refuses prototype pollution keys', () => {
    const r = ok('{"__proto__": {"polluted": true}, "papers": []}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(r.notes.join()).toMatch(/unsafe/);
  });
  it('rejects oversized input', () => {
    const r = parseImport('x'.repeat(15_000_001));
    expect(r.ok).toBe(false);
  });
});

describe('strict validation', () => {
  it('path-based option count errors', () => {
    const p = syntheticPaper('p1', 3);
    p.questions[1]!.options = ['a', 'b', 'c'];
    const r = validateDoc(doc(p));
    expect(paths(r)).toContain('papers[0].questions[1].options: Expected 4 options, found 3');
  });
  it('detects dropped questions (gaps) and count mismatches', () => {
    const p = syntheticPaper('p1', 5);
    p.questions.splice(2, 1);
    const r = validateDoc(doc(p));
    expect(r.warnings.find((w) => w.confirm && /missing 3/.test(w.message))).toBeTruthy();
  });
  it('chunked paper warns but needs confirmation', () => {
    const r = validateDoc(doc(syntheticPaper('p1', 40, { from: 1, to: 20 })));
    expect(r.errors).toEqual([]);
    expect(r.warnings.find((w) => /Found 20 questions of 40/.test(w.message))?.confirm).toBe(true);
  });
  it('duplicate numbers and numbers beyond the count are errors', () => {
    const p = syntheticPaper('p1', 3);
    p.questions[2]!.n = 2;
    p.questions.push({ ...p.questions[0]!, n: 9 });
    const r = paths(validateDoc(doc(p)));
    expect(r.some((e) => /Duplicate question number 2/.test(e))).toBe(true);
    expect(r.some((e) => /Question 9 is beyond questionCount 3/.test(e))).toBe(true);
  });
  it('answers out of range and invalid answers', () => {
    const p = syntheticPaper('p1', 2);
    (p.questions[0] as { answer: unknown }).answer = 'E';
    (p.questions[1] as { answer: unknown }).answer = 3;
    const r = paths(validateDoc(doc(p)));
    expect(r).toContain('papers[0].questions[0].answer: Answer E is outside the 4 options');
    expect(r.some((e) => e.startsWith('papers[0].questions[1].answer: Expected a letter'))).toBe(true);
  });
  it('missing answers are allowed (keyed later)', () => {
    const r = validateDoc(doc(syntheticPaper('p1', 2, { answers: false })));
    expect(r.errors).toEqual([]);
    expect(r.doc.papers[0]!.questions.every((q) => q.answer === null)).toBe(true);
  });
  it('table options need one row per option', () => {
    const r = validateDoc(doc({ id: 'p', title: 'T', questionCount: 1, optionCount: 4, questions: [{ n: 1, stem: 's', table: { columns: ['x', 'y'], rows: [['1', '2'], ['3', '4'], ['5']] }, answer: 'A' }] }));
    expect(paths(r)).toEqual(['papers[0].questions[0].table.rows: Expected 4 rows (one per option), found 3', 'papers[0].questions[0].table.rows[2]: Expected 2 cells, found 1']);
  });
  it('missing images become needs-figure; whole-question images must exist', () => {
    const r = validateDoc(doc({ id: 'p', title: 'T', questionCount: 2, questions: [
      { n: 1, stem: 's', figure: { file: 'images/missing.png' }, options: ['a', 'b', 'c', 'd'], answer: 'A' },
      { n: 2, image: 'images/q2.png', answer: 'B' },
    ] }), new Set(['images/q2.png']));
    expect(r.errors).toEqual([]);
    expect(r.doc.papers[0]!.questions[0]!.figure).toEqual({ kind: 'needed', note: 'Missing image images/missing.png' });
  });
  it('answers-only documents parse many key styles', () => {
    const notes = new Set<string>();
    expect(parseKey('ACDB', notes)).toEqual([0, 2, 3, 1]);
    expect(parseKey('1. a 2. c 3. D 4.b', notes)).toEqual([0, 2, 3, 1]);
    expect(parseKey('A, C, ?, B', notes)).toEqual([0, 2, null, 1]);
    expect(parseKey({ 1: 'A', 2: 'B' }, notes)).toEqual([0, 1]);
    expect(parseKey('AXB', notes)).toBeUndefined();
  });
  it('rejects unknown format versions', () => {
    expect(paths(validateDoc({ format: 'other/9', papers: [] }))[0]).toMatch(/Unsupported format/);
  });
  it('enforces limits', () => {
    const p = syntheticPaper('p', 3);
    p.questions[0]!.stem = 'x'.repeat(6000);
    expect(paths(validateDoc(doc(p)))).toContain('papers[0].questions[0].stem: Text is longer than 5000 characters');
    expect(paths(validateDoc({ papers: Array.from({ length: 501 }, () => ({})) }))[0]).toMatch(/Too many papers/);
  });
  it('valid fixtures also satisfy the published JSON Schema', () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    const d = doc(syntheticPaper('p1', 3), syntheticPaper('p2', 2, { answers: false }));
    expect(validate(d)).toBe(true);
    expect(validate({ format: 'dmc-pack/1', answers: [{ paper: 'p1', key: 'ABC' }] })).toBe(true);
    expect(validate({ format: 'dmc-pack/1', papers: [{ id: 'Bad Id' }] })).toBe(false);
  });
});

describe('SVG sanitiser (hostile input)', () => {
  it('strips scripts, handlers, external refs and foreignObject', () => {
    const r = sanitizeSvg(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)" viewBox="0 0 10 10">
      <script>alert(1)</script><foreignObject><div>x</div></foreignObject>
      <a href="javascript:alert(1)"><rect width="5" height="5"/></a>
      <image href="https://evil.example/x.png"/>
      <use href="https://evil.example/s.svg#a"/><use href="#ok"/>
      <rect width="1" height="1" style="fill:url(https://evil.example/x)" onclick="x()"/>
      <circle r="2" fill="url(#grad)"/></svg>`);
    expect(r.svg).toBeTruthy();
    expect(r.svg).not.toMatch(/script|onload|onclick|foreignObject|evil|javascript/i);
    expect(r.svg).toMatch(/href="#ok"/);
    expect(r.svg).toMatch(/url\(#grad\)/);
  });
  it('refuses doctype/entity tricks, non-svg and oversized input', () => {
    expect(sanitizeSvg('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg>&a;</svg>').svg).toBeNull();
    expect(sanitizeSvg('<html><body/></html>').svg).toBeNull();
    expect(sanitizeSvg('<svg>' + 'x'.repeat(200_001) + '</svg>').svg).toBeNull();
  });
  it('a hostile figure in an import is cleaned and reported', () => {
    const p = { id: 'p', title: 'T', questionCount: 1, questions: [{ n: 1, stem: 's', figure: { svg: '<svg xmlns="http://www.w3.org/2000/svg"><script>x</script><line x1="0" y1="0" x2="1" y2="1" onmouseover="x"/></svg>' }, options: ['a', 'b', 'c', 'd'], answer: 'A' }] };
    const r = validateDoc(doc(p));
    expect(r.errors).toEqual([]);
    expect(r.warnings.some((w) => /Removed unsafe SVG parts/.test(w.message))).toBe(true);
    const f = r.doc.papers[0]!.questions[0]!.figure;
    expect(f?.kind === 'svg' && !/script|onmouseover/.test(f.svg)).toBe(true);
  });
});

describe('markup', () => {
  it('parses superscripts, subscripts, fractions and roots', () => {
    expect(parseMarkup('m s^{-2}')).toEqual([{ t: 'text', v: 'm s' }, { t: 'sup', c: [{ t: 'text', v: '-2' }] }]);
    expect(parseMarkup('v_0 x^2')).toEqual([{ t: 'text', v: 'v' }, { t: 'sub', c: [{ t: 'text', v: '0' }] }, { t: 'text', v: ' x' }, { t: 'sup', c: [{ t: 'text', v: '2' }] }]);
    expect(markupToText('\\frac{1}{2}mv^{2}')).toBe('(1)/(2)mv^2');
    expect(markupToText('\\sqrt{x} is **NOT**')).toBe('√(x) is NOT');
  });
  it('treats a lone caret as text and survives deep nesting', () => {
    expect(markupToText('a ^ b')).toBe('a ^ b');
    expect(() => parseMarkup('^{'.repeat(500))).not.toThrow();
  });
});

describe('merge', () => {
  const v = (d: unknown) => validateDoc(d).doc;
  it('merges chunks of the same paper', () => {
    const a = mergeDoc(v(doc(syntheticPaper('p1', 40, { from: 1, to: 20 }))), 'pk', new Map(), new Map());
    expect(a.conflicts).toEqual([]);
    const first = a.papers[0]!;
    expect(first.present).toBe(20);
    const b = mergeDoc(v(doc(syntheticPaper('p1', 40, { from: 21, to: 40 }))), 'pk', new Map([['p1', first]]), new Map());
    expect(b.conflicts).toEqual([]);
    expect(b.papers[0]!.present).toBe(40);
    expect(b.plan[0]!.status).toBe('merge');
  });
  it('re-importing the same paper is identical, not duplicated', () => {
    const a = mergeDoc(v(doc(syntheticPaper('p1', 3))), 'pk', new Map(), new Map());
    const b = mergeDoc(v(doc(syntheticPaper('p1', 3))), 'pk', new Map([['p1', a.papers[0]!]]), new Map());
    expect(b.plan[0]!.status).toBe('identical');
    expect(b.papers[0]!.questions).toHaveLength(3);
  });
  it('rejects conflicting content for an existing question', () => {
    const a = mergeDoc(v(doc(syntheticPaper('p1', 3))), 'pk', new Map(), new Map());
    const changed = syntheticPaper('p1', 3);
    changed.questions[0]!.stem = 'Different';
    const b = mergeDoc(v(doc(changed)), 'pk', new Map([['p1', a.papers[0]!]]), new Map());
    expect(b.conflicts[0]!.message).toMatch(/already exists with different content/);
  });
  it('applies an answers-only key later, and keys later chunks from it', () => {
    const a = mergeDoc(v(doc(syntheticPaper('p1', 4, { answers: false, from: 1, to: 2 }))), 'pk', new Map(), new Map());
    const k = mergeDoc(v({ format: 'dmc-pack/1', answers: [{ paper: 'p1', key: 'BCDA' }] }), 'pk', new Map([['p1', a.papers[0]!]]), new Map());
    expect(k.conflicts).toEqual([]);
    expect(k.answersApplied).toBe(2);
    expect(k.papers[0]!.questions.map((q) => q.answer)).toEqual([1, 2]);
    const c = mergeDoc(v(doc(syntheticPaper('p1', 4, { answers: false, from: 3, to: 4 }))), 'pk', new Map([['p1', k.papers[0]!]]), new Map());
    expect(c.papers[0]!.questions.map((q) => q.answer)).toEqual([1, 2, 3, 0]);
    expect(c.papers[0]!.keyed).toBe(4);
  });
  it('rejects keys of the wrong length or for unknown papers', () => {
    const a = mergeDoc(v(doc(syntheticPaper('p1', 4))), 'pk', new Map(), new Map());
    const k = mergeDoc(v({ answers: [{ paper: 'p1', key: 'ABC' }, { paper: 'nope', key: 'A' }] }), 'pk', new Map([['p1', a.papers[0]!]]), new Map());
    expect(k.conflicts.map((c) => c.message)).toEqual(['Key has 3 answers but "p1" has 4 questions', 'No paper "nope" in this pack or import. Check the paper id.']);
  });
  it('a contradicting key is a conflict', () => {
    const a = mergeDoc(v(doc(syntheticPaper('p1', 4))), 'pk', new Map(), new Map());
    const k = mergeDoc(v({ answers: [{ paper: 'p1', key: 'AAAA' }] }), 'pk', new Map([['p1', a.papers[0]!]]), new Map());
    expect(k.conflicts.length).toBeGreaterThan(0);
  });
  it('hash ignores the answer but not the content', () => {
    const base = { stem: 's', optionCount: 4, options: [{ text: 'a' }] };
    expect(questionHash(base)).toBe(questionHash({ ...base }));
    expect(questionHash(base)).not.toBe(questionHash({ ...base, stem: 't' }));
  });
});

describe('prompts', () => {
  it('generation prompt contains the essentials', () => {
    const p = buildPrompt({ subject: 'Physics', paperTitle: 'Paper 12', group: ['2025'], optionCount: 4, questionCount: 40, timeLimitMin: 75, diagrams: 'draw', answerKey: 'separate', explanations: false });
    for (const s of ['"id": "paper-12"', 'exactly 40', 'never drop', 'only one JSON code block', 'Worked example', 'Set every "answer" to null', 'svg', 'uncertain'])
      expect(p.toLowerCase()).toContain(s.toLowerCase());
    // The worked example must itself be valid input.
    const ex = /```json\n([\s\S]+?)```/.exec(p)![1]!;
    const r = ok(ex);
    expect(paths(r)).toEqual([]);
  });
  it('chunk and key options change the prompt', () => {
    const p = buildPrompt({ subject: 'Physics', paperTitle: 'P', group: [], optionCount: 5, diagrams: 'placeholder', answerKey: 'attached', from: 21, to: 40, explanations: true });
    expect(p).toContain('ONLY questions 21 to 40');
    expect(p).toContain('exactly 20');
    expect(p).toContain('A, B, C, D, E');
    expect(p).toContain('from the mark scheme');
    expect(ok(/```json\n([\s\S]+?)```/.exec(p)![1]!).errors).toEqual([]);
  });
  it('fix prompt lists the exact errors', () => {
    const p = buildFixPrompt([{ path: 'papers[0].questions[12].options', message: 'Expected 4 options, found 3' }], '{"a":1}');
    expect(p).toContain('papers[0].questions[12].options: Expected 4 options, found 3');
    expect(p).toContain('COMPLETE corrected JSON');
    expect(p).toContain('{"a":1}');
  });
  it('answers prompt round-trips through the validator', () => {
    const p = buildAnswersPrompt({ paperId: 'p1', paperTitle: 'P', questionCount: 4, optionCount: 4 });
    expect(p).toContain('"paper": "p1"');
  });
  it('lenient parse of fenced multi-block output', () => {
    const t = '```json\n{"papers":[]}\n```\ntext\n```json\n{"answers":[{"paper":"x","key":"A"}]}\n```';
    expect(Array.isArray(lenientParse(t).value)).toBe(true);
  });
});
