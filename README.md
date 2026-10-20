# MCQ Engine

A static web app for practising multiple-choice exam papers. Pick a pack, answer in
**exam mode** (timed, results at the end) or **practice mode** (no timer, feedback after
each answer), then review every mistake with an explanation. One mark per question.

Plain HTML, CSS and JavaScript modules. No framework, no build step, no runtime network
calls: this folder is the website. Two vendored libraries: KaTeX (maths) and fflate (zip).

## Run locally

```
cd mcq-engine
python3 -m http.server 8000
```

Open http://localhost:8000. (Opening `index.html` as a file does not work: browsers block
modules from `file://`.)

## Tests

```
npm test            # node --test: engine, store, text/XSS, validator, importer, parity with Python, leaderboard
npm run e2e         # optional: Playwright + Chromium if installed, otherwise prints SKIP
```

There are no npm dependencies; `package.json` only holds scripts. The parity test needs
`python3`. The e2e script serves the site with the production Content-Security-Policy.

## Deploy to Netlify

1. Connect the repository in Netlify.
2. Base directory: `mcq-engine` (this folder). Publish directory: `.`. Build command: leave empty.
3. Done. `netlify.toml` sets the security headers and the functions folder.

For the optional leaderboard, also:

4. Create a Supabase project and run `docs/leaderboard.sql` in its SQL editor.
5. In Netlify, set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` (the service role key; it stays
   server-side). Optionally set `ALLOWED_PACKS`, e.g. `sample-physics:8,my-paper:40`
   (pack id, optionally with its question count so only full-length runs are accepted).

Without these variables the functions answer 503 and the app hides the leaderboard.

## Packs are not hosted

The deployed site contains only the engine and the synthetic sample pack. Real exam papers
are copyrighted and are **not** published on the site. They are shared as zip files, and
each student loads one into their own browser, where it stays (IndexedDB) and works offline.

### Load a pack as a student

On the home page, under "Load your own pack", choose the `.zip` you were given (or the
unzipped folder, or a single `pack.json`). The pack is checked first. If anything is
wrong it is refused with a list of problems, one line per question. A loaded pack stays
until you press Remove. Your scores and mistakes live in this browser only; use
"Your data" → Export to move them to another device.

### Make a pack

The format is in [docs/PACK_FORMAT.md](docs/PACK_FORMAT.md). From a question paper PDF and
its mark scheme PDF (needs poppler: `apt install poppler-utils` or `brew install poppler`):

```
python3 tools/mcqpack.py extract --profile profiles/cie-mcq-v1.json \
    --paper paper.pdf --scheme scheme.pdf --id my-pack --title "My paper" --out packs/my-pack
python3 tools/mcqpack.py merge packs/my-pack/pack.json structured.json -o packs/my-pack/pack.json
python3 tools/mcqpack.py validate packs/my-pack
```

`extract` cuts one snapshot per question. `merge` adds typed questions, explanations and
other fields by question id (optional). `validate` runs the same rules as the app. Zip the
folder to share it. To ship a pack with the site instead, add it to `packs/index.json`.

`npm run sample` rebuilds `packs/sample-physics` from the synthetic fixture
(`tests/make_fixture.py`, needs reportlab) and `tests/sample/structured.json`.

## Leaderboard: known weakness

Grading happens in the browser and the client sends only its score, so anyone can post a
fake score with a hand-made request. The server rejects implausible numbers (wrong mode,
`correct > total`, under 2 s per question, unknown pack or wrong length when
`ALLOWED_PACKS` is set) but cannot detect a plausible fake. Treat the board as
friendly, not authoritative. The upgrade path (in PACK_FORMAT.md): submit the answers instead of
the score and let the server grade against answer keys it keeps for ranked packs, which then
ship without answers. There is no rate limiting; add Netlify's rate limiting or a
Supabase check if abuse appears.

## Keyboard and accessibility

A–D or 1–4 answer, ← → move between questions, Enter goes to the next question. Timer
milestones (10, 5, 1 minutes left) and results are announced to screen readers. Tap targets
are at least 44 px. The layout works from 360 px wide. Light and dark themes follow the
system, and paper snapshots always sit on white.

## Assumptions

- The original mcqpack toolkit was not available; the format, schema, Python tool and
  fixture here were written from the build brief (see DECISIONS.md #1).
- Questions have exactly one correct option; other question types are shown as
  "unsupported" and not scored.
- A pack's `timeLimitSec` is for the whole paper; without it, 90 s per question.
- Closing the tab pauses an exam's timer (resume continues from the saved time).

See [DECISIONS.md](DECISIONS.md) for every judgement call and
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how the code fits together.
