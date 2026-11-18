<img src="brand/tab-lockup-light.svg" alt="builtbyjosef" height="40">

# DMC: Dynamic Multiple Choice

Practise multiple-choice exam papers the way the real exam feels: full timed papers, random sets that cover the pool, mistakes drills, with honest progress analytics. Local-first: everything works offline and signed out. An optional account syncs progress across devices, and a school email unlocks the school Library of shared paper sets.

* **Packs and papers.** A pack (for example "AS Physics Paper 1") holds many papers, browsable by year and series.
* **Sessions.** Paper (always the full paper), Random (least-seen first) or Mistakes drill, in Exam mode (timed, results at the end) or Practice mode (instant feedback).
* **Honest numbers.** Rolling averages, an observed-trend summary with sample sizes, pace analysis and a rushed-error alert.
* **Typed packs (primary).** An AI agent or chat turns a PDF into validated typed questions ([PACK_BUILDER_GUIDE.md](docs/PACK_BUILDER_GUIDE.md)); DMC validates, cross-checks numbers against the PDF and writes the fix prompt if anything is wrong. `node tools/validate-pack.mjs <zip>` runs the same validator from a terminal.
* **PDF papers (lighter path).** Drop question paper PDFs and mark schemes: practise from the PDF, confirm the key in a grid, snip questions for drills.
* **Board mode.** A large question pane beside a completely blank writing half for external whiteboard tools; fullscreen, themes, reveal, jump, elimination and revisit.
* **Import PDF with AI.** Selected-page NVIDIA vision extraction, explicit consent, retry/recovery and editable review through the existing importer.
* **Two ways to practise a paper.** Typed questions (DMC mode) or the real PDF beside an A–D answer sheet (PDF mode), with the same grading and stats.
* **Google accounts.** Sign in with Google; isolated account and guest workspaces; sync on by default for school accounts.
* **School Library.** Paper sets shared inside the school, versioned, stored once by file hash, with an admin panel. Runs on Cloudflare: [setup.md](setup.md), [docs/LIBRARY_POLICY.md](docs/LIBRARY_POLICY.md).

## Run it

Needs Node 22. In a terminal (Ubuntu/WSL, macOS Terminal or the VS Code terminal), in the repository root:

```bash
npm install
npm run dev          # http://localhost:5173 (uses the built-in development backend for accounts)
npm run worker:local # the real Worker with local D1 and R2 at http://localhost:8787
```

## Check and build

Same terminal, repository root:

```bash
npm run check        # typecheck, lint, unit tests, production build
npm run e2e          # Playwright: plain build on 4173 and a mock-backend build on 4174
node tools/validate-pack.mjs pilot/my-pack.dmc.zip   # validate a pack outside the app
npm run build        # production build into dist/
npm run preview      # serve dist/ at http://localhost:4173
```

The first time on a new machine, `npm run e2e` may need the browser: `npx playwright install chromium`.

## Deploy

One Cloudflare Worker serves the built app and every `/api/*` route, with D1 for the database, R2 for files and a nightly backup. Production is `https://dmc.stjbscouncil.org`, staging `https://dmc-staging.stjbscouncil.org`. Every step (databases, buckets, migrations, secrets, Google sign-in, custom domains, deploy, the one-time copy from Supabase, rollback and restore) is in [setup.md](setup.md). No secret ever goes into the frontend.

When a new version is deployed, open copies of DMC show "A new version of DMC is ready". The update is never applied in the middle of a session.

## Make a paper set

1. In DMC, choose **Make a paper set with AI** (or **Add papers** on a paper set). Fill in the paper details and copy the prompt.
2. Open any AI chat, attach the question paper PDF (and the mark scheme if you have it), and paste the prompt.
3. Copy the reply, then choose **Import** in DMC and paste it. DMC tidies common formatting slips, checks every question, and shows a preview to compare with the paper. If something is wrong, **Copy fix prompt** gives the AI the exact errors.

The format is documented in [docs/PACK_FORMAT.md](docs/PACK_FORMAT.md), with a JSON Schema in [schema/](schema/). Zips (JSON plus an `images/` folder) and folders import too, and **Export pack** writes the same format for sharing.

Daily 10 is retired. Existing session records remain readable and survive backup, restore and sync; ordinary papers, Random and mistakes drills remain available. Clearing a question from the mistakes bank is a repeat-practice convenience, not proof of topic mastery.

## Your data

Paper sets, PDFs and progress live in this browser's storage on this device; clearing site data erases them. Signed in with sync on, progress, historical question snapshots and paper-set outlines sync to your account; full paper files and PDF/image assets stay local (Library sets download again on a new device); your own paper sets can also be backed up to the account if you choose. Use **Settings > Data > Export everything** regularly; backups are checked with a checksum and merge without deleting anything.

Implementation, compatibility, test coverage and limitations are described in [Upgrade delivery notes](docs/UPGRADE.md).

## Project layout

```
src/lib/engine/   timer, random draw, mistakes bank, grading, session lifecycle
src/lib/stats/    rolling averages, verdict, rushed-error alert, KPIs, dashboard
src/lib/format/   lenient reader, validator, merge, markup, SVG sanitiser, prompts
src/lib/data/     IndexedDB (versioned, with migrations), import, keys, PDFs, backups
src/lib/backend/  Cloudflare client and in-browser mock behind one typed interface
src/lib/library/  posting, downloading and covers for the school Library
src/lib/sync/     local-first sync
src/lib/pdf/      pdf.js wrapper (lazy)
worker/           the Cloudflare Worker: auth, Library, files, sync, AI, admin, backups
migrations/       D1 schema
shared/           code shared by app and Worker (paper keys, set manifest, AI prompts)
tools/            validate-pack.mjs (CLI validator)
scripts/          demo packs, restore-backup.mjs, migrate-supabase.mjs
src/screens/      library, pack dashboard, question screen, results, settings
src/ui/           design-system components, charts, brand
brand/            builtbyjosef logo files (picked up automatically)
docs/             PACK_FORMAT, PACK_BUILDER_GUIDE, LIBRARY_POLICY, DECISIONS, PROGRESS, reviews
```

Built by Josef Yang. Built to a standard. Built to move.
