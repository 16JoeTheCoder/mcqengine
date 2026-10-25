import { LETTERS } from '../types';
import { FORMAT_ID, slugify, type Issue } from './validate';

export type DiagramMode = 'none' | 'draw' | 'placeholder' | 'zip';

export interface PromptOptions {
  subject: string;
  packTitle?: string;
  /** Several papers in one go: the AI reads titles, ids, counts and time limits from each cover. */
  multi?: boolean;
  paperTitle: string;
  paperId?: string;
  group: string[];
  optionCount: number;
  questionCount?: number;
  timeLimitMin?: number;
  diagrams: DiagramMode;
  /** ZIP mode: crop the whole question (most reliable) or only its diagram. */
  zipCrop?: 'question' | 'diagram';
  /** 'attached': mark scheme provided with the paper; 'separate': keyed in a later step; 'none': no key available. */
  answerKey: 'attached' | 'separate' | 'none';
  /** Optional chunk, inclusive (single paper only). */
  from?: number;
  to?: number;
  explanations: boolean;
}

const letters = (k: number) => LETTERS.slice(0, k).join(', ');
const SVG_EX = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 80'><rect x='60' y='25' width='80' height='30' fill='none' stroke='black' stroke-width='2'/><line x1='140' y1='40' x2='190' y2='40' stroke='black' stroke-width='2'/><text x='150' y='32' font-size='12'>F</text></svg>`;

/** Image paths the importer checks: a file's paper id and question number must match its question. */
export const imagePath = (paperId: string, n: number, option?: string) => `images/${paperId}/q${String(n).padStart(2, '0')}${option ? `-${option}` : ''}.png`;

function example(o: PromptOptions, keyed: boolean): string {
  const k = o.optionCount;
  const id = o.multi ? '9702-s25-12' : 'example-paper-1';
  const opts = ['2.0 × 10^{3} N', '4.0 × 10^{3} N', '−2.0 × 10^{3} N', '8.0 × 10^{2} N', '1.6 × 10^{4} N'].slice(0, k);
  const rows = [['scalar', 'vector'], ['vector', 'scalar'], ['vector', 'vector'], ['scalar', 'scalar'], ['neither', 'vector']].slice(0, k);
  const ans = (l: string) => (keyed ? `"${l}"` : 'null');
  const q1base = `"n": 1,\n        "stem": "A car of mass 1.2 × 10^{3} kg accelerates at 3.0 m s^{-2}, as shown. Which force is needed? Use \\\\frac{1}{2}mv^{2} for kinetic energy where asked.",`;
  let q1: string;
  if (o.diagrams === 'zip' && o.zipCrop !== 'diagram') q1 = `"n": 1,\n        "image": "${imagePath(id, 1)}",`;
  else if (o.diagrams === 'zip') q1 = `${q1base}\n        "figure": { "file": "${imagePath(id, 1)}", "alt": "Block with force F to the right" },\n        "options": ${JSON.stringify(opts)},`;
  else if (o.diagrams === 'draw') q1 = `${q1base}\n        "figure": { "svg": "${SVG_EX}", "alt": "Block with force F to the right" },\n        "options": ${JSON.stringify(opts)},`;
  else q1 = `${q1base}\n        "figure": { "needed": true, "note": "Block on a surface with force F to the right" },\n        "options": ${JSON.stringify(opts)},`;
  return `{
  "format": "${FORMAT_ID}",
  "papers": [{
    "id": "${id}",
    "title": "${o.multi ? 'May/June 2025 Paper 12' : 'Example Paper 1'}",
    "group": ["2025", "May/June"],${o.multi ? `\n    "source": { "questionPaper": "9702_s25_qp_12.pdf"${keyed ? ', "markScheme": "9702_s25_ms_12.pdf"' : ''} },` : ''}
    "questionCount": 40,
    "timeLimitMinutes": 75,
    "optionCount": ${k},
    "questions": [
      {
        ${q1}
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
  const multi = !!o.multi;
  const zip = o.diagrams === 'zip';
  const cropWhole = zip && o.zipCrop !== 'diagram';
  const id = o.paperId || slugify(o.paperTitle) || 'paper-1';
  const chunk = !multi && o.from && o.to ? { from: o.from, to: o.to } : null;
  const keyed = o.answerKey === 'attached';
  const what = multi ? 'question papers' : 'question paper';
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(
    `You are transcribing multiple-choice exam ${what} into JSON for DMC, a practice app. A student will answer these questions for real exam preparation, so accuracy matters far more than speed: one dropped minus sign, wrong power of ten, missing unit or diagram attached to the wrong question makes a question wrong.`,
    '',
    '## Task',
  );
  if (multi) {
    push(
      `Transcribe EVERY attached ${o.subject ? `${o.subject} ` : ''}question paper. Each paper becomes one object in the "papers" array.`,
      '- First identify each question paper by the code on its front cover (subject code, series and year, paper/variant number), not by file order.',
    );
    if (keyed)
      push(
        '- Pair each question paper with its mark scheme by that same code (for example 9702_s25_qp_12 pairs only with 9702_s25_ms_12). Never take answers from a mark scheme with a different code. If a paper has no matching mark scheme, set its answers to null and say so in "uncertain" on question 1.',
      );
    push(
      '- Paper "id": lowercase letters, digits and hyphens built from the code: <subject code>-<series letter><two-digit year>-<paper number>. Series letters: m = Feb/March, s = May/June, w = Oct/Nov (for other boards use a similar short, stable code). Example: 9702 May/June 2025 paper 12 → "9702-s25-12". The same paper must always get the same id.',
      '- "title": like "May/June 2025 Paper 12". "group": ["<year>", "<series>"], e.g. ["2025", "May/June"].',
      '- "questionCount" and "timeLimitMinutes": read them from that paper\'s front cover.',
      '- "source": the file names you used, { "questionPaper": "<file>"' + (keyed ? ', "markScheme": "<file>"' : '') + ' }, so the student can trace every paper.',
    );
  } else {
    push(`Transcribe the attached ${o.subject ? `${o.subject} ` : ''}question paper "${o.paperTitle}" into exactly ONE JSON object in the format below.`);
    if (chunk) push(`Transcribe ONLY questions ${chunk.from} to ${chunk.to}. Keep their original numbers. Another message will cover the rest.`);
  }
  if (keyed)
    push(`Take every "answer" from the matching mark scheme. Never work out an answer yourself; if the mark scheme is unreadable for a question, use null and say so in "uncertain".`);
  else if (o.answerKey === 'separate') push(`The answer key will be added in a separate step. Set every "answer" to null. Do not solve the questions.`);
  else push(`There is no answer key. Set every "answer" to null. Do not solve the questions.`);

  push('', `## Format (${FORMAT_ID})`, 'Use exactly these fields. Do not rename anything.', '```', '{', `  "format": "${FORMAT_ID}",`);
  if (o.packTitle) push(`  "pack": { "title": ${JSON.stringify(o.packTitle)}, "subject": ${JSON.stringify(o.subject)} },`);
  if (multi)
    push(
      '  "papers": [',
      '    {',
      '      "id": "<from the cover code, see above>",',
      '      "title": "<series year Paper N>",',
      '      "group": ["<year>", "<series>"],',
      `      "source": { "questionPaper": "<file name>"${keyed ? ', "markScheme": "<file name>"' : ''} },`,
      '      "questionCount": <from the cover>,',
      '      "timeLimitMinutes": <from the cover>,',
      `      "optionCount": ${k},`,
      '      "questions": [ ...one object per question, in order... ]',
      '    },',
      '    ...one object per paper...',
      '  ]',
      '}',
      '```',
    );
  else
    push(
      '  "papers": [{',
      `    "id": ${JSON.stringify(id)},`,
      `    "title": ${JSON.stringify(o.paperTitle)},`,
      `    "group": ${JSON.stringify(o.group)},`,
      o.questionCount ? `    "questionCount": ${o.questionCount},` : `    "questionCount": <the total number of questions printed on the paper>,`,
      o.timeLimitMin ? `    "timeLimitMinutes": ${o.timeLimitMin},` : `    "timeLimitMinutes": <the time allowed in minutes, from the front cover, or null>,`,
      `    "optionCount": ${k},`,
      '    "questions": [ ...one object per question, in order... ]',
      '  }]',
      '}',
      '```',
    );
  push(
    '',
    'Each question object:',
    `- "n": the question number as printed (1, 2, 3...).`,
    cropWhole
      ? `- For a question WITH a diagram, graph or picture: "image": the path of its cropped picture (see Diagrams), and no "stem" or "options". For every other question: "stem" and "options" as below.`
      : `- "stem": the full question text, copied exactly, including every sentence, value and unit.`,
    ...(cropWhole ? [`- "stem": the full question text, copied exactly, including every sentence, value and unit.`] : []),
    `- "options": an array of exactly ${k} strings, in order ${letters(k)}. Do NOT include the letters themselves ("A.", "(B)").`,
    `- "table": use INSTEAD of "options" when the options are a table (a header row, then one row per letter): { "columns": [header cells], "rows": [${k} rows, each with one cell per column] }. Leave out the letter column.`,
    `- "answer": ${keyed ? `one of ${letters(k)} from the matching mark scheme, or null if unreadable` : 'null'}.`,
    ...(cropWhole ? [] : [`- "figure": only if the question has a diagram, graph or picture (see Diagrams).`]),
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
  if (zip) {
    push(
      'You must run code for this (Python). If you cannot run code or create files, stop and say so instead of guessing.',
      '1. Open each question paper PDF with PyMuPDF (fitz) and render each page at 200 dpi.',
      '2. Find where each question starts: its number printed at the left margin. A question ends where the next question number starts (or at the page footer). Use the PDF text positions to find these boundaries; do not estimate from memory.',
      cropWhole
        ? '3. For every question that has a diagram, graph, picture or diagram options, crop the WHOLE question (from its number down to just before the next question, full text width, including the options) and save it as a PNG. If a question continues onto the next page, stack both parts vertically into one PNG.'
        : '3. For every question that has a diagram, graph or picture, crop ONLY that diagram (its full extent including labels, with a small margin) and save it as a PNG. If the options are diagrams, crop each option separately.',
      `4. Name every file exactly ${imagePath('<paper id>', 7).replace('07', '<NN>')} where <paper id> is that paper's id and <NN> is the two-digit question number (q07 for question 7)${cropWhole ? '' : `; option pictures are ${imagePath('<paper id>', 7, 'A').replace('07', '<NN>')}, -B, -C, -D`}. The importer REJECTS a file whose paper id or question number does not match the question that uses it.`,
      cropWhole
        ? `5. In that question's JSON put "image": "${imagePath('<paper id>', 7).replace('07', '<NN>')}" and leave out "stem" and "options".`
        : `5. In that question's JSON put "figure": { "file": "${imagePath('<paper id>', 7).replace('07', '<NN>')}", "alt": "one-line description" }${cropWhole ? '' : `; for picture options use "options": [{ "file": "...-A.png" }, ...]`}.`,
      '6. Diagram check, one by one: open each saved PNG and confirm it shows the diagram belonging to that question number of that paper (match the labels and values against the question text). Fix any crop that is cut off, shows the wrong question, or mixes two questions.',
      '7. Every PNG must be used by exactly one question, and every question with a diagram must have its PNG.',
    );
  } else if (o.diagrams === 'draw')
    push(
      '- For a simple diagram (circuit, ray diagram, force arrows, block on a slope, a graph made of straight lines or simple curves), draw it as inline SVG: "figure": { "svg": "<svg ...>...</svg>", "alt": "one-line description" }.',
      `- SVG rules: include xmlns and a viewBox; black strokes, fill="none" or white; font-size 12 or more; copy every label, value and unit from the paper exactly; use single quotes for attributes inside the JSON string; no <script>, no <image>, no CSS, no external links; keep each SVG under 4 KB.`,
      '- The diagram must be the one printed with THAT question number. Before drawing, check the question number next to the diagram on the page.',
      '- If a diagram is too detailed to redraw faithfully (a photo, a graph you must read values from, a complex apparatus), do NOT approximate it. Use "figure": { "needed": true, "note": "what the diagram shows" } and the student will attach a screenshot.',
      `- If the options themselves are diagrams (e.g. four graphs), make each option an object: { "svg": "<svg ...>" } or { "figure": { "needed": true, "note": "graph for option A" } }.`,
    );
  else if (o.diagrams === 'placeholder')
    push(
      '- Do not draw diagrams. For every question with a diagram or graph, add "figure": { "needed": true, "note": "short description of the diagram" }. The student will attach screenshots.',
      `- If the options themselves are diagrams, make each option { "figure": { "needed": true, "note": "option A diagram" } }.`,
    );
  else push('- These papers should have no diagrams. If you find one, add "figure": { "needed": true, "note": "short description" } rather than leaving it out.');

  push(
    '',
    '## Never',
    '- Never skip, merge or reorder questions. Never invent or "improve" wording, values or options.',
    '- Never drop minus signs, powers of ten, units, subscripts or decimal places.',
    '- Never move a diagram or an answer to a different question or paper.',
    '- Never guess silently. If unsure, transcribe your best reading AND add "uncertain" with the reason.',
    '- Never add fields that are not described above.',
    '',
    '## Before you finish: self-check',
    chunk
      ? `1. Count your question objects: there must be exactly ${chunk.to - chunk.from + 1}, numbered ${chunk.from} to ${chunk.to} with no gaps or repeats.`
      : multi
        ? '1. For each paper: count its question objects; there must be exactly questionCount, numbered 1 to questionCount with no gaps or repeats. Check you included every attached paper.'
        : `1. Count your question objects: there must be exactly ${o.questionCount ?? 'questionCount'}, numbered 1 to ${o.questionCount ?? 'questionCount'} with no gaps or repeats.`,
    `2. Every typed question has exactly ${k} options (or ${k} table rows).`,
    '3. Re-read every number, sign, power of ten and unit against the paper, one question at a time.',
    keyed ? `4. Every answer matches the matching mark scheme for that paper and question number.` : '4. Every "answer" is null.',
    '5. The JSON is valid: double quotes around keys and strings, backslashes doubled, no trailing commas, no comments.',
    ...(zip ? ['6. Every image path exists in the zip, follows the naming rule, and matches its paper id and question number.'] : []),
    'Fix anything that fails before you reply.',
    '',
    '## Reply',
  );
  if (zip)
    push(
      '- Write pack.json (the JSON above, all papers) and the images folder into one zip file named dmc-pack.zip, with pack.json at the top level next to images/. Give me the zip as a download.',
      '- Work paper by paper and write each paper\'s JSON to a file before starting the next, so nothing is cut off; then combine them into pack.json.',
      '- In the chat, after the download link, list each paper id with its question count and the number of images. Nothing else.',
    );
  else if (multi)
    push(
      '- Return the JSON in code blocks and nothing else: no introduction, no summary.',
      '- Several papers are long. Put ONE paper per code block, each block a complete JSON object with "format" and a "papers" array holding that one paper. If you are running out of space, stop after a complete paper and write only: CONTINUE. When I reply "continue", carry on with the next paper. Never stop in the middle of a paper.',
    );
  else push('Return only one JSON code block and nothing else: no introduction, no summary.');
  push('', `## Worked example (format only; do not copy its content)`, '```json', example(o, keyed), '```');
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
