import { LETTERS } from '../types';
import { FORMAT_ID, slugify, type Issue } from './validate';

export type DiagramMode = 'none' | 'draw' | 'placeholder';

export interface PromptOptions {
  subject: string;
  packTitle?: string;
  paperTitle: string;
  paperId?: string;
  group: string[];
  optionCount: number;
  questionCount?: number;
  timeLimitMin?: number;
  diagrams: DiagramMode;
  /** 'attached': mark scheme provided with the paper; 'separate': keyed in a later step; 'none': no key available. */
  answerKey: 'attached' | 'separate' | 'none';
  /** Optional chunk, inclusive. */
  from?: number;
  to?: number;
  explanations: boolean;
}

const letters = (k: number) => LETTERS.slice(0, k).join(', ');

function example(k: number, diagrams: DiagramMode, keyed: boolean): string {
  const opts4 = ['2.0 × 10^{3} N', '4.0 × 10^{3} N', '−2.0 × 10^{3} N', '8.0 × 10^{2} N', '1.6 × 10^{4} N'].slice(0, k);
  const rows = [
    ['scalar', 'vector'],
    ['vector', 'scalar'],
    ['vector', 'vector'],
    ['scalar', 'scalar'],
    ['neither', 'vector'],
  ].slice(0, k);
  const ans = (l: string) => (keyed ? `"${l}"` : 'null');
  const fig =
    diagrams === 'draw'
      ? `"figure": { "svg": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 80'><rect x='60' y='25' width='80' height='30' fill='none' stroke='black' stroke-width='2'/><line x1='140' y1='40' x2='190' y2='40' stroke='black' stroke-width='2'/><text x='150' y='32' font-size='12'>F</text></svg>", "alt": "Block with force F to the right" },`
      : `"figure": { "needed": true, "note": "Block on a surface with force F to the right" },`;
  return `{
  "format": "${FORMAT_ID}",
  "papers": [{
    "id": "example-paper-1",
    "title": "Example Paper 1",
    "group": ["2025", "May/June"],
    "questionCount": 40,
    "timeLimitMinutes": 75,
    "optionCount": ${k},
    "questions": [
      {
        "n": 1,
        "stem": "A car of mass 1.2 × 10^{3} kg accelerates at 3.0 m s^{-2}. Which force is needed? Use \\\\frac{1}{2}mv^{2} for kinetic energy where asked.",
        ${fig}
        "options": ${JSON.stringify(opts4)},
        "answer": ${ans('B')}
      },
      {
        "n": 2,
        "stem": "Which row is correct for momentum and kinetic energy?",
        "table": { "columns": ["momentum", "kinetic energy"], "rows": ${JSON.stringify(rows)} },
        "answer": ${ans('B')}
      }
    ]
  }]
}`;
}

/** The import prompt: complete, self-contained, tailored to the dialog answers. */
export function buildPrompt(o: PromptOptions): string {
  const k = o.optionCount;
  const id = o.paperId || slugify(o.paperTitle) || 'paper-1';
  const chunk = o.from && o.to ? { from: o.from, to: o.to } : null;
  const keyed = o.answerKey === 'attached';
  const countLine = o.questionCount
    ? `"questionCount": ${o.questionCount}`
    : `"questionCount": <the total number of questions printed on the paper>`;
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(
    `You are transcribing a multiple-choice exam paper into JSON for DMC, a practice app. A student will answer these questions for real exam preparation, so accuracy matters far more than speed: one dropped minus sign, wrong power of ten or missing unit makes a question wrong.`,
    '',
    '## Task',
    `Transcribe the attached ${o.subject ? `${o.subject} ` : ''}question paper "${o.paperTitle}" into exactly ONE JSON object in the format below.`,
  );
  if (chunk) push(`Transcribe ONLY questions ${chunk.from} to ${chunk.to}. Keep their original numbers. Another message will cover the rest.`);
  if (o.answerKey === 'attached')
    push(`The mark scheme (answer key) is attached as well. Take every "answer" from the mark scheme. Never work out an answer yourself; if the mark scheme is unreadable for a question, use null and say so in "uncertain".`);
  else if (o.answerKey === 'separate')
    push(`The answer key will be added in a separate step. Set every "answer" to null. Do not solve the questions.`);
  else push(`There is no answer key. Set every "answer" to null. Do not solve the questions.`);

  push(
    '',
    `## Format (${FORMAT_ID})`,
    'Use exactly these fields. Fill in the values shown; do not rename anything.',
    '```',
    '{',
    `  "format": "${FORMAT_ID}",`,
  );
  if (o.packTitle) push(`  "pack": { "title": ${JSON.stringify(o.packTitle)}, "subject": ${JSON.stringify(o.subject)} },`);
  push(
    '  "papers": [{',
    `    "id": ${JSON.stringify(id)},`,
    `    "title": ${JSON.stringify(o.paperTitle)},`,
    `    "group": ${JSON.stringify(o.group)},`,
    `    ${countLine},`,
    o.timeLimitMin ? `    "timeLimitMinutes": ${o.timeLimitMin},` : `    "timeLimitMinutes": <the time allowed in minutes, from the front cover, or null>,`,
    `    "optionCount": ${k},`,
    '    "questions": [ ...one object per question, in order... ]',
    '  }]',
    '}',
    '```',
    '',
    'Each question object:',
    `- "n": the question number as printed (1, 2, 3...).`,
    `- "stem": the full question text, copied exactly, including every sentence, value and unit.`,
    `- "options": an array of exactly ${k} strings, in order ${letters(k)}. Do NOT include the letters themselves ("A.", "(B)").`,
    `- "table": use INSTEAD of "options" when the options are a table (a header row, then one row per letter): { "columns": [header cells], "rows": [${k} rows, each with one cell per column] }. Leave out the letter column.`,
    `- "answer": ${keyed ? `one of ${letters(k)} from the mark scheme, or null if unreadable` : 'null'}.`,
    `- "figure": only if the question has a diagram, graph or table that is part of the stem (see Diagrams).`,
    `- "uncertain": only if something could not be read with confidence: a short note saying exactly what (e.g. "exponent on 10 in option C is unclear").`,
  );
  if (o.explanations)
    push(`- "explanation": one or two sentences explaining the correct answer, taken from the mark scheme or examiner report. If neither explains it, leave the field out rather than inventing one.`);

  push(
    '',
    '## Writing maths and science text',
    '- Superscript: ^{...} e.g. "m s^{-2}", "10^{-19} C", "x^{2}". Subscript: _{...} e.g. "v_{0}", "E_{k}", "R_{2}".',
    '- Fractions: \\\\frac{numerator}{denominator}. Square roots: \\\\sqrt{...}. In JSON the backslash must be doubled, so write "\\\\frac{1}{2}".',
    '- Greek letters and symbols as Unicode characters: λ μ Ω ρ θ Δ π ε σ ° × ± ≤ ≥ ≈ → ∝ √.',
    '- Use the true minus sign or a hyphen for negatives; never drop it. Keep "×10^{n}" exactly as printed.',
    '- Bold words that the paper emphasises (e.g. NOT, ALWAYS) as **NOT**.',
    '- A line break inside text is \\n. Use it only where the paper starts a new line that matters (e.g. listed statements 1, 2, 3).',
    '- Statements numbered 1, 2, 3 in the stem stay in the stem; options like "1 and 2 only" are copied as written.',
    '',
    '## Diagrams',
  );
  if (o.diagrams === 'draw')
    push(
      '- For a simple diagram (circuit, ray diagram, force arrows, block on a slope, a graph made of straight lines or simple curves), draw it as inline SVG: "figure": { "svg": "<svg ...>...</svg>", "alt": "one-line description" }.',
      `- SVG rules: include xmlns and a viewBox; black strokes, fill="none" or white; font-size 12 or more; copy every label, value and unit from the paper exactly; use single quotes for attributes inside the JSON string; no <script>, no <image>, no CSS, no external links; keep each SVG under 4 KB.`,
      '- If a diagram is too detailed to redraw faithfully (a photo, a graph you must read values from, a complex apparatus), do NOT approximate it. Use "figure": { "needed": true, "note": "what the diagram shows" } and the student will attach a screenshot.',
      `- If the options themselves are diagrams (e.g. four graphs), make each option an object: { "svg": "<svg ...>" } or { "figure": { "needed": true, "note": "graph for option A" } }.`,
    );
  else if (o.diagrams === 'placeholder')
    push(
      '- Do not draw diagrams. For every question with a diagram or graph, add "figure": { "needed": true, "note": "short description of the diagram" }. The student will attach screenshots.',
      `- If the options themselves are diagrams, make each option { "figure": { "needed": true, "note": "option A diagram" } }.`,
    );
  else push('- This paper should have no diagrams. If you find one, add "figure": { "needed": true, "note": "short description" } rather than leaving it out.');

  push(
    '',
    '## Never',
    '- Never skip, merge or reorder questions. Never invent or "improve" wording, values or options.',
    '- Never drop minus signs, powers of ten, units, subscripts or decimal places.',
    '- Never guess silently. If unsure, transcribe your best reading AND add "uncertain" with the reason.',
    '- Never add fields that are not described above, and never add text outside the JSON.',
    '',
    '## Before you reply: self-check',
    chunk
      ? `1. Count your question objects: there must be exactly ${chunk.to - chunk.from + 1}, numbered ${chunk.from} to ${chunk.to} with no gaps or repeats.`
      : `1. Count your question objects: there must be exactly ${o.questionCount ?? 'questionCount'}, numbered 1 to ${o.questionCount ?? 'questionCount'} with no gaps or repeats.`,
    `2. Every question has exactly ${k} options (or ${k} table rows).`,
    '3. Re-read every number, sign, power of ten and unit against the paper, one question at a time.',
    keyed ? `4. Every answer matches the mark scheme for that question number.` : '4. Every "answer" is null.',
    '5. The JSON is valid: double quotes around keys and strings, backslashes doubled, no trailing commas, no comments.',
    'Fix anything that fails, then reply.',
    '',
    '## Reply',
    'Return only one JSON code block and nothing else: no introduction, no summary.',
    '',
    `## Worked example (format only; do not copy its content)`,
    '```json',
    example(k, o.diagrams, keyed),
    '```',
  );
  return lines.join('\n');
}

/** Second step: read a mark scheme and return just the answer key. */
export function buildAnswersPrompt(o: { paperId: string; paperTitle: string; questionCount: number; optionCount: number }): string {
  return [
    `Read the attached mark scheme for "${o.paperTitle}" and return its multiple-choice answer key as JSON for the DMC practice app.`,
    '',
    '```',
    `{ "format": "${FORMAT_ID}", "answers": [ { "paper": ${JSON.stringify(o.paperId)}, "key": "<${o.questionCount} letters>" } ] }`,
    '```',
    '',
    `- "key" is one string of exactly ${o.questionCount} letters (${letters(o.optionCount)}), in question order 1 to ${o.questionCount}, no spaces. Example: "BDACC…".`,
    '- Use ? for any question whose answer is missing or unreadable. Never work an answer out yourself.',
    `- Self-check: count the letters (must be ${o.questionCount}) and compare five random questions against the mark scheme again.`,
    '- Return only one JSON code block and nothing else.',
  ].join('\n');
}

const MAX_ECHO = 60_000;

/** Repair prompt: the exact errors plus an instruction to return only corrected JSON. */
export function buildFixPrompt(errors: Issue[], original?: string, syntax?: string): string {
  const list = syntax ? [`- The JSON could not be read: ${syntax}`] : errors.slice(0, 80).map((e) => `- ${e.path}: ${e.message}`);
  if (errors.length > 80) list.push(`- …and ${errors.length - 80} more of the same kinds.`);
  const lines = [
    'The DMC importer rejected the JSON you produced. Fix exactly these problems:',
    '',
    ...list,
    '',
    'Rules:',
    '- Re-check the affected questions against the original paper; do not invent content to make the errors go away. If something truly cannot be read, keep your best reading and add an "uncertain" note.',
    '- Keep everything that was already correct unchanged, including ids and question numbers.',
    '- Paths like papers[0].questions[12] count from 0, so questions[12] is the 13th question object.',
    '- Return the COMPLETE corrected JSON (not just the changed parts) as one JSON code block and nothing else.',
  ];
  if (original && original.length <= MAX_ECHO) lines.push('', 'Here is the JSON you sent:', '```json', original.trim(), '```');
  return lines.join('\n');
}
