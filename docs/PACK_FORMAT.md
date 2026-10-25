# DMC pack format, version 1 (`dmc-pack/1`)

The primary path: an AI agent (Claude Code with [PACK_BUILDER_GUIDE.md](PACK_BUILDER_GUIDE.md), or any AI chat with the prompt DMC generates under "Make a pack with AI") turns a question paper PDF into typed questions in this format, and DMC validates them. A pack zip may also carry the PDFs themselves, so every typed question can open its page ("View in PDF"), and imports are cross-checked against the PDF text. The lighter path, a bare PDF plus a key, uses the same format with `"bare": true` (section 9). This document is the full specification. The machine-readable schema is [`schema/dmc-pack-1.schema.json`](../schema/dmc-pack-1.schema.json); the importer is `src/lib/format/` (lenient reader, validator, merge).

The design goals, in order: an LLM can produce it reliably, the intake forgives common LLM mistakes, every remaining error points to an exact path with a fix, and silent mis-transcription is caught before it reaches practice.

## 1. Shape

```json
{
  "format": "dmc-pack/1",
  "pack": { "title": "AS Physics Paper 1", "subject": "Physics" },
  "papers": [
    {
      "id": "may-june-2025-paper-12",
      "title": "May/June 2025 Paper 12",
      "group": ["2025", "May/June"],
      "questionCount": 40,
      "timeLimitMinutes": 75,
      "optionCount": 4,
      "questions": [
        {
          "n": 1,
          "stem": "A car of mass 1.2 × 10^{3} kg accelerates at 3.0 m s^{-2}. What is the resultant force?",
          "options": ["2.0 × 10^{3} N", "3.6 × 10^{3} N", "4.0 × 10^{2} N", "1.2 × 10^{4} N"],
          "answer": "B"
        }
      ]
    }
  ],
  "answers": [{ "paper": "may-june-2025-paper-12", "key": "BDACC…" }]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `format` | no (assumed) | Always `"dmc-pack/1"`. Any other value is rejected. |
| `pack` | no | Title and subject. Used only when the import creates a new pack. |
| `papers[]` | `papers` or `answers` | One object per paper. One AI response normally holds exactly one paper. |
| `papers[].id` | yes | Stable id: lowercase letters, digits, hyphens, at most 64 characters. Re-importing the same id merges instead of duplicating. |
| `papers[].title` | yes | Display title. |
| `papers[].source` | no | `{ "questionPaper": "<file>", "markScheme": "<file>" }`: the files it was transcribed from, for traceability. |
| `papers[].group` | no | Path for the papers browser, most general first, at most 4 levels: `["2025", "Oct/Nov"]`. |
| `papers[].questionCount` | yes | The number of questions printed on the paper. Used to detect dropped questions. |
| `papers[].timeLimitMinutes` | no | The hard time cap. If absent, the import wizard asks for it; no timer can exceed it. |
| `papers[].optionCount` | no | 2 to 5. If absent, the most common option count in the paper is used. |
| `papers[].gradeBoundaries` | no | Minimum raw marks per grade: `{ "A": 31, "B": 27 }`. Results then show the marks to the next grade. |
| `papers[].pdf` | no | `{ "questionPaper": "pdfs/9702_s23_qp_12.pdf", "markScheme": "pdfs/9702_s23_ms_12.pdf" }`: PDFs inside the zip or folder, stored on the device. |
| `papers[].bare` | no | `true` for a paper practised from its PDF without typed content (section 9). Needs `pdf.questionPaper`. |
| `answers[]` | no | Answer keys applied after the questions (see 4). |

### Question

| Field | Required | Meaning |
| --- | --- | --- |
| `n` | yes | Question number as printed, 1 to `questionCount`. |
| `page` | no | Page of the question paper PDF the question starts on (1-based). "View in PDF" opens it there. |
| `snip` | no | `{ "page": 3, "x": 0.08, "y": 0.12, "w": 0.84, "h": 0.3 }`: the question's rectangle on the question paper PDF, as fractions of the page. Rendered at runtime. |
| `stem` | yes, unless `image` | Full question text in DMC markup (see 3). |
| `options` | one of `options`, `table`, `image` | Exactly `optionCount` entries, in order A, B, C…. Each is a string, or an object `{ "text": "…", "svg": "<svg…>" }`, `{ "file": "images/q5a.png" }` or `{ "figure": { "needed": true, "note": "…" } }` when the options are pictures. |
| `table` | | Options laid out as a table: `{ "columns": ["force", "energy"], "rows": [["N", "J"], …] }`, with one row per option and one cell per column. Leave out the letter column. |
| `image` | | A whole-question screenshot (path inside a zip or folder). Options may then be omitted; the buttons show letters. |
| `figure` | no | A diagram in the stem: `{ "svg": "<svg…>", "alt": "…" }`, `{ "file": "images/q5.png", "alt": "…" }`, or `{ "needed": true, "note": "graph of v against t" }`. |
| `answer` | yes | `"A"`–`"E"`, or `null` until keyed. |
| `topic` | no | Short topic tag. |
| `explanation` | no | Shown in Practice mode and review. |
| `uncertain` | no | The transcriber's note about something it could not read reliably. Surfaced in the wizard. |

## 2. Figures

* **Inline SVG** for simple diagrams an LLM can draw (circuits, rays, force arrows, straight-line graphs). It is sanitised on import (an allowlist of shape and text elements; scripts, event handlers, `foreignObject`, external `href`s and `url()`s are removed) and is then rendered through `<img>`, where SVG cannot run code or load anything. Limit 200 KB.
* **Image files** in a zip or folder import, referenced by relative path (`images/q5.png`). PNG, JPEG, WebP, GIF or SVG, at most 5 MB each. Images are stored by SHA-256, so the same image is stored once.
* **Placeholder**: `{ "needed": true, "note": "…" }`. The question shows a "Needs figure" badge with a one-click attach (file picker or paste a screenshot). A referenced file that is missing from the import becomes a placeholder automatically.

Figures and screenshots always sit on a light paper panel and are never colour-inverted.

### Diagram files must name their question

Image files follow one naming rule: `images/<paper id>/q<NN>.png` (two-digit question number), with `-A`, `-B`… for option pictures (`images/9702-s25-12/q07-B.png`). The importer enforces it:

* A file whose name gives a different paper id or question number than the question that uses it is an **error** ("named for paper p1 question 8, but attached to question 7"). A diagram on the wrong question can never import silently.
* An image in the zip that no question uses needs explicit confirmation, because that usually means a diagram was attached to the wrong question or dropped.
* Files with other names are accepted without the name check.

## 3. Markup

A deliberately tiny LaTeX subset, which LLMs already write fluently. It is parsed into a token tree and rendered with text nodes only; no HTML is ever interpreted.

| Write | Renders as |
| --- | --- |
| `m s^{-2}`, `x^2` | superscript (braces, or a short run: digits with optional sign, or one letter) |
| `v_{0}`, `E_k` | subscript (braces, or one letter or digit) |
| `\frac{1}{2}` | stacked fraction (nesting allowed) |
| `\sqrt{2gh}` | square root |
| `**NOT**` | bold |
| a newline (`\n` in JSON) | line break |

Greek letters and symbols are plain Unicode (`λ Ω μ ° × ± ≤ → ∝`). In JSON a backslash must be doubled: `"\\frac{1}{2}"`. The importer also repairs the common case where it was not (see 5).

Why not a maths library: exam MCQs need superscripts, subscripts, simple fractions and roots. KaTeX would add about 280 KB for features the format does not need.

## 4. Chunks and answer keys

* **Several papers, one pack.** Import papers one response at a time into the same pack. Each paper merges by its `id`.
* **Chunks of one paper.** Long papers can be transcribed in parts (questions 1–20, then 21–40). Parts merge by paper `id` plus question `n`. A question number that already exists with identical content is skipped; with different content it is a conflict and nothing is written.
* **Keys later.** A second AI step can read the mark scheme and return only:

  ```json
  { "format": "dmc-pack/1", "answers": [{ "paper": "may-june-2025-paper-12", "key": "BDACCABD…" }] }
  ```

  `key` has exactly `questionCount` letters in question order; `?` marks an unknown answer. The importer also accepts `"1A 2C 3D"`, `"A, C, D"`, lowercase letters and `{ "1": "A", "2": "C" }`. A key fills `null` answers; a key letter that contradicts an existing answer is a conflict. Keys are remembered, so chunks that arrive after the key are keyed on arrival.
* A paper can be started only when all `questionCount` questions are present and keyed. The UI says which is missing.

## 4a. Several papers in one go

The prompt dialog's "Several papers" mode asks the AI to transcribe every attached paper. It identifies each paper by the code on its cover, not by file order, and builds stable ids from it (`9702-s25-12`: subject code, series letter m/s/w with a two-digit year, paper number). It pairs each mark scheme with its question paper by that same code.

* **Plain JSON:** one paper per code block, and the AI writes `CONTINUE` and waits if it runs out of space. Paste all the replies into Import at once; the code blocks are combined.
* **ZIP** (needs an AI that can run code, such as ChatGPT with data analysis or Claude with code execution): the AI locates question boundaries in the PDF text, crops either the whole question (recommended) or just the diagram, and names each crop by the rule above. It checks every crop against its question, writes one file per paper so nothing is cut off, and returns `dmc-pack.zip` (`pack.json` plus `images/`).

## 5. Tolerant intake, strict validation

Before validation the reader silently repairs, and then reports:

* markdown code fences, and prose before or after the JSON; several fenced blocks are combined;
* smart quotes used as delimiters (smart quotes inside text are kept), single-quoted strings;
* trailing commas, missing commas between items, `//` and `/* */` comments, unquoted keys, `True`/`False`/`None`;
* raw line breaks inside strings, unescaped LaTeX backslashes (`\frac`, `\theta`, `\lambda`);
* LaTeX symbol commands (`\lambda` → λ, `\times` → ×), `$…$` delimiters around maths, zero-width characters;
* property name case and common aliases (`question` → `stem`, `choices` → `options`, `correct_answer` → `answer`, `number` → `n`);
* answer letters such as `b`, `(C)`, `D.`; option prefixes such as `"A. 2.0 N"`;
* a bare paper object or a bare array of papers.

Then it validates strictly, with path-based messages that also count from zero:

```
papers[0].questions[12].options: Expected 4 options, found 3
papers[0].questions[7].n: Duplicate question number 8 (also at questions[6])
papers[0].questions[3].answer: Answer E is outside the 4 options
answers[0].key: Key has 39 answers but "may-june-2025-paper-12" has 40 questions
```

Dropped-question detection: gaps in numbering, numbers above `questionCount`, duplicates, fewer questions than `questionCount`, and identical consecutive questions are reported. Gaps and count mismatches need explicit confirmation in the wizard.

When validation fails, **Copy fix prompt** produces a prompt with the exact errors, the original JSON (up to 60 000 characters) and an instruction to return only the complete corrected JSON.

## 6. Limits and safety

All content is untrusted, including packs from the school Library. Text reaches the page through text nodes only. Limits: 15 MB of JSON, 100 MB zip, 2 000 entries per zip, 60 MB per decompressed entry and 300 MB in total (counted while inflating, so a zip bomb or a header that lies about sizes stops at the limit), 60 MB per PDF, 5 MB per image, 500 papers and 20 000 questions per import, 200 questions per paper, 5 000 characters per text field, 4 group levels. Zip entries with `..`, absolute paths or drive letters are refused. `__proto__`, `constructor` and `prototype` keys are dropped. Doctype and entity declarations in SVG are refused. PDFs must start with a PDF signature and open with scripting, XFA and WebAssembly off.

**Transcription cross-check.** When a zip carries the question paper PDF, every number in each typed question (stem, options, table) is looked up in the PDF text. A question where two or more numbers, and more than half, are missing is listed in the review step to compare with the paper before import. Scanned PDFs (no text) skip the check.

**Command line.** The same validator runs outside the app. From the repository root, in any terminal: `node tools/validate-pack.mjs <pack.zip | folder | pack.json>` (add `--json` for machine output). Exit code 0 means the pack would import.

## 7. Ids, hashes and re-import

* Question id: `<paper id>#<n>`. Paper storage key: `<pack id>::<paper id>`.
* Every question has a content hash of what the student sees (stem, options, table, figures), excluding the answer and notes. Re-importing the same paper is recognised as identical; a changed question is a conflict, so a re-import never silently overwrites.
* Fixes made in the app ("Fix this question") are stored as overrides keyed by question id. They survive re-imports, and a re-import of an exported pack that carries those fixes is recognised as identical.

## 8. Zip and folder imports

```
my-paper.zip
├── pack.json          (or any single .json file)
├── images/
│   ├── 9702-s23-12/q05.png
│   └── 9702-s23-12/q12.png
└── pdfs/              (optional)
    ├── 9702_s23_qp_12.pdf
    └── 9702_s23_ms_12.pdf
```

A single top-level folder inside the zip is ignored, so `my-paper/pack.json` works too. `__MACOSX/` and dotfiles are skipped. DMC's own **Export pack** writes exactly this layout, so exports round-trip through the same importer.

Backups (`dmc-backup/1`) are a separate format: a zip with `dmc-backup.json` (manifest with a SHA-256 checksum) and `data.json`, or a single JSON file for the progress-only tier. Drop either into the same import box.

## 9. Bare PDF papers (the lighter path)

A paper can be practised straight from its PDF: the question screen shows the page beside letter buttons. Choose **PDF papers** in Import (or drop PDFs on the page): file names like `9702_s23_qp_12.pdf` fill in the title, group, id and time cap, and a mark scheme named like the paper (`9702_s23_ms_12.pdf`) is read for the key, which you confirm in a letter grid. Without a key the paper runs in Exam mode and is graded when a key arrives.

In the format this is a paper with `"bare": true`, `pdf.questionPaper`, and questions that may be just `{ "n": 1, "answer": "B" }` (missing numbers are filled in up to `questionCount`). Bare questions are not individually viewable until snipped: drag a rectangle on the page (**Snip questions** in the paper's start dialog) and assign the question number. Snipped questions enter drills and Daily 10; a paper becomes Random-eligible once every question is snipped. Snips export as `snip` rectangles, never as images, so nothing is duplicated.

## 10. Pack for friends

**Export pack** writes this format: papers, keys, typed content, PDFs, snips and boundaries, with your fixes applied. It never includes sessions, stats or settings. Packs downloaded from the school Library cannot be exported this way; they are shared through the Library only.
