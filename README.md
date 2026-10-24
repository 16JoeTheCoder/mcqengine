<img src="brand/tab-lockup-light.svg" alt="builtbyjosef" height="40">

# DMC: Dynamic Multiple Choice

Practise multiple-choice exam papers the way the real exam feels: full timed papers, random sets that cover the pool, and drills on your mistakes, with honest progress analytics. Everything is local-first: no account, no server, no tracking, and it works offline once loaded.

* **Packs and papers.** A pack (for example "AS Physics Paper 1") holds many papers, browsable by year and series.
* **Sessions.** Paper (always the full paper), Random (least-seen first) or Mistakes drill, in Exam mode (timed, results at the end) or Practice mode (instant feedback).
* **Honest numbers.** Rolling averages, a verdict with confidence that says when a change is within noise, pace analysis and a rushed-error alert.
* **AI-assisted packs.** DMC writes a precise prompt; any AI chat turns your PDF into JSON; DMC validates it and writes the fix prompt if anything is wrong.

## Run it

Needs Node 22. In a terminal (Ubuntu/WSL, macOS Terminal or the VS Code terminal), in the repository root:

```bash
npm install
npm run dev          # http://localhost:5173
```

## Check and build

Same terminal, repository root:

```bash
npm run check        # typecheck, lint, unit tests, production build
npm run e2e          # Playwright end-to-end tests (builds and serves dist/ on port 4173)
npm run build        # production build into dist/
npm run preview      # serve dist/ at http://localhost:4173
```

The first time on a new machine, `npm run e2e` may need the browser: `npx playwright install chromium`.

## Deploy

`dist/` is plain static files with relative paths and hash routing, so it works on any static host under any base path.

* **Netlify** (current): `netlify.toml` sets the build command (`npm run build`), the publish folder (`dist`) and the security headers. Push to the connected branch.
* **Anywhere else:** run `npm run build` and upload `dist/`. Serve `sw.js` and `index.html` with `Cache-Control: no-cache` so updates are found.

When a new version is deployed, open copies of DMC show "A new version of DMC is ready". The update is never applied in the middle of a session.

## Make a pack

1. In DMC, choose **Make a pack with AI** (or **Add papers** on a pack). Fill in the paper details and copy the prompt.
2. Open any AI chat, attach the question paper PDF (and the mark scheme if you have it), and paste the prompt.
3. Copy the reply, then choose **Import** in DMC and paste it. DMC tidies common formatting slips, checks every question, and shows a preview to compare with the paper. If something is wrong, **Copy fix prompt** gives the AI the exact errors.

The format is documented in [docs/PACK_FORMAT.md](docs/PACK_FORMAT.md), with a JSON Schema in [schema/](schema/). Zips (JSON plus an `images/` folder) and folders import too, and **Export pack** writes the same format for sharing.

## Your data

Packs and progress live in this browser's storage on this device. Clearing site data erases them. Use **Settings > Data > Export everything** regularly and keep the file somewhere safe; import it on another device to move. Backups are checked with a checksum and merge without deleting anything.

## Project layout

```
src/lib/engine/   timer, random draw, mistakes bank, grading, session lifecycle
src/lib/stats/    rolling averages, verdict, rushed-error alert, KPIs, dashboard
src/lib/format/   lenient reader, validator, merge, markup, SVG sanitiser, prompts
src/lib/data/     IndexedDB (versioned, with migrations), import, backups
src/screens/      library, pack dashboard, question screen, results, settings
src/ui/           design-system components, charts, brand
brand/            builtbyjosef logo files (picked up automatically)
docs/             PACK_FORMAT.md, DECISIONS.md, design standard, review reports
```

Built by Josef Yang. Built to a standard. Built to move.
