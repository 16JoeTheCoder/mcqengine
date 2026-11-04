/** Pure transport contract shared by the browser and Worker. Never import credentials here. */
export const AI_PROTOCOL_VERSION = 1;
export const AI_LIMITS = {
  pagesPerBatch: 4,
  payloadBytes: 4_000_000,
  pageTextChars: 60_000,
  imageBytes: 1_000_000,
  imageDataUrlChars: 1_333_400,
  questionsPerBatch: 60,
  questionNumber: 200,
  questionTextChars: 5000,
  uncertaintyChars: 4000,
  tableColumns: 8,
  tableTextChars: 2000,
  warnings: 100,
  warningChars: 2000,
} as const;

export interface AiPage { page: number; role: 'question' | 'markscheme'; text?: string; image?: string }
export interface AiInput { pages: AiPage[]; hasMarkScheme: boolean }
export interface AiQuestion {
  n: number; page: number; stem: string; options: string[]; answer: string | null;
  figureNeeded?: boolean; uncertain?: string; explanation?: string;
  table?: { columns: string[]; rows: string[][] };
  crop?: { x: number; y: number; w: number; h: number };
}
export interface AiBatch { questions: AiQuestion[]; warnings: string[] }
export interface AiConfig { configured: boolean; model: string; maxPagesPerBatch: number; maxPayloadBytes: number; maxTextChars: number; maxImageBytes: number }

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const string = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const fail = (message: string): never => { throw new Error(message); };

/** Identical hostile-output checks at both boundaries; callers choose transport error codes. */
export function validateAiBatch(value: unknown, sourcePages: number[], hasMarkScheme: boolean): AiBatch {
  const l = AI_LIMITS;
  if (!object(value) || !only(value, ['questions','warnings']) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > l.questionsPerBatch || (value.warnings !== undefined && (!Array.isArray(value.warnings) || value.warnings.length > l.warnings || !value.warnings.every(w => string(w,l.warningChars))))) return fail('The AI returned an invalid or empty extraction. Retry this page or use manual import.');
  const questions: AiQuestion[] = [];
  const warnings = [...(value.warnings as string[] | undefined ?? [])];
  const seen = new Set<number>();
  for (const q of value.questions) {
    if (!object(q) || !only(q,['n','page','stem','options','answer','figureNeeded','uncertain','explanation','table','crop']) || !Number.isInteger(q.n) || Number(q.n) < 1 || Number(q.n) > l.questionNumber || !sourcePages.includes(Number(q.page)) || typeof q.page !== 'number' || !string(q.stem,l.questionTextChars) || !q.stem.trim() || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5 || !q.options.every(o => string(o,l.questionTextChars) && o.trim()) || (q.answer !== null && (typeof q.answer !== 'string' || q.answer.length !== 1 || !'ABCDE'.slice(0,q.options.length).includes(q.answer))) || (q.figureNeeded !== undefined && typeof q.figureNeeded !== 'boolean') || (q.uncertain !== undefined && !string(q.uncertain,l.uncertaintyChars)) || (q.explanation !== undefined && !string(q.explanation,l.questionTextChars))) return fail('A question has missing content, incomplete options, an invalid answer or source page, or unexpected fields. Retry or use manual import.');
    if (seen.has(Number(q.n))) return fail('The AI returned duplicate question numbers. Retry this page.');
    seen.add(Number(q.n));
    if (q.table !== undefined) {
      const t = q.table;
      if (!object(t) || !only(t,['columns','rows']) || !Array.isArray(t.columns) || !t.columns.length || t.columns.length > l.tableColumns || !t.columns.every(s=>string(s,l.tableTextChars)) || !Array.isArray(t.rows) || t.rows.length !== q.options.length || !t.rows.every(row=>Array.isArray(row) && row.length === (t.columns as unknown[]).length && row.every(s=>string(s,l.tableTextChars)))) return fail('The AI returned an incomplete options table.');
    }
    if (q.crop !== undefined) {
      const c = q.crop;
      if (!object(c) || !only(c,['x','y','w','h']) || !['x','y','w','h'].every(k=>typeof c[k] === 'number' && Number.isFinite(c[k]) && Number(c[k]) >= 0 && Number(c[k]) <= 1) || Number(c.w) <= 0 || Number(c.h) <= 0 || Number(c.x) + Number(c.w) > 1 || Number(c.y) + Number(c.h) > 1) return fail('The AI returned an invalid source crop. Retry this page.');
    }
    const out = { ...q, answer: hasMarkScheme ? q.answer : null } as unknown as AiQuestion;
    if (!hasMarkScheme) delete out.explanation;
    const figureWarning = `Question ${out.n}: source figure needs review.`;
    if (out.figureNeeded && !out.crop && !warnings.includes(figureWarning)) warnings.push(figureWarning);
    questions.push(out);
  }
  questions.sort((a,b)=>a.n-b.n);
  for (let i=1;i<questions.length;i++) {
    if (questions[i]!.n <= questions[i-1]!.n+1) continue;
    const gap = `Missing question numbers between ${questions[i-1]!.n} and ${questions[i]!.n}.`;
    if (!warnings.includes(gap)) warnings.push(gap);
  }
  return {questions,warnings};
}
