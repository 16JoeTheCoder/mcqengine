# Pack builder guide (for AI agents)

How an AI agent, typically Claude Code in this repository, turns exam PDFs into a DMC pack that imports cleanly. The format is [PACK_FORMAT.md](PACK_FORMAT.md); this guide is the procedure. Real exam content never goes into git: work in `pilot/` (ignored) and name outputs `*.local.*` or `*.dmc.zip` (ignored).

## Inputs and outputs

* In: one or more question paper PDFs, ideally with mark schemes (`9702_s23_qp_12.pdf`, `9702_s23_ms_12.pdf`).
* Out: `pilot/<pack>.dmc.zip` containing `pack.json`, `pdfs/` (the source PDFs) and `images/<paper id>/q<NN>.png` crops where needed.

## Procedure

1. **Identify each paper from its cover**, not the file order: syllabus code, series, year, paper number, number of questions, time allowed. Paper id: `<code>-<m|s|w><yy>-<paper>` (`9702-s23-12`). Title `May/June 2023 Paper 12`, group `["2023", "May/June"]`.
2. **Extract text with positions** (PyMuPDF `page.get_text("dict")`, or pdfplumber). Question boundaries are the question numbers at the left margin; a question ends where the next number starts or at the footer.
3. **Transcribe every question exactly** into `stem` and `options` (or `table`). Copy every value, unit, sign and power of ten. Use the markup: `^{}` `_{}` `\\frac{}{}` `\\sqrt{}` `**bold**`, Unicode for Greek and symbols. Record `page` for each question (1-based page of the PDF file).
4. **Diagrams:** crop the whole question (recommended) or the diagram to `images/<paper id>/q<NN>.png` at 200 dpi, and reference it with `"image"` or `"figure": { "file": … }`. The importer rejects a file whose name disagrees with the question that uses it.
5. **Answers come only from the mark scheme** with the same code. Never solve a question to fill a key. Unreadable: `null` plus an `uncertain` note.
6. **Self-check before writing the zip:** question numbers 1..questionCount with no gaps or duplicates; option count constant; every number in each stem appears in that page's PDF text (this is what DMC's import cross-check does); every crop shows the right question.
7. **Write** `pack.json` with `"pdf": { "questionPaper": "pdfs/<file>", "markScheme": "pdfs/<file>" }` per paper, add the PDFs, zip it.
8. **Validate**, from the repository root in the VS Code or WSL terminal:

   ```bash
   node tools/validate-pack.mjs pilot/<pack>.dmc.zip
   ```

   Fix every `x` line (they carry exact paths such as `papers[0].questions[12].options`), rerun until it prints `ok`. `!` lines are warnings; read them.
9. **Hand over:** the student imports the zip in DMC (Import > Choose file), checks the review step's sample questions and cross-check, and imports.

## Bare papers (no transcription)

When typing is not worth it, produce a bare paper: `{ "id": …, "title": …, "questionCount": 40, "timeLimitMinutes": 75, "bare": true, "pdf": { "questionPaper": "pdfs/<file>" } }` plus `"answers": [{ "paper": "<id>", "key": "BDAC…" }]`. Optional `snip` rectangles per question (`{ "n": 7, "answer": "C", "snip": { "page": 3, "x": 0.08, "y": 0.1, "w": 0.84, "h": 0.28 } }`) make those questions usable in drills and Daily 10.

## Why this shape

* Typed questions are the best-supported path: searchable, accessible, small, and checkable against the PDF.
* The PDFs travel with the pack so any typed question can be compared with the original in one tap.
* The importer, not the agent, is the final authority: the agent's job is to make the validator say `ok` honestly.
