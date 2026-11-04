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
* **Email accounts.** Verification codes, isolated account/guest workspaces and explicit guest-progress adoption.
* **School Library and sync.** Supabase: [docs/SUPABASE_SETUP.md](docs/SUPABASE_SETUP.md), [docs/LIBRARY_POLICY.md](docs/LIBRARY_POLICY.md).

## Run it

Needs Node 22. In a terminal (Ubuntu/WSL, macOS Terminal or the VS Code terminal), in the repository root:

```bash
npm install
npm run dev          # http://localhost:5173 (uses the built-in development backend for accounts)
```

For the real accounts and Library, copy `.env.example` to `.env.local` and fill in the two public Supabase values (see docs/SUPABASE_SETUP.md).

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

`dist/` is plain static files with relative paths and hash routing, so it works on any static host under any base path.

The frontend is configured for **Cloudflare Pages** (`npm run build`, output `dist/`). An authenticated **Cloudflare Worker** serves same-origin `/api/*` AI requests. Supabase remains the Auth, database, and private storage backend. See [Cloudflare, email, SMTP, subdomain and NVIDIA setup](docs/CLOUDFLARE_SETUP.md) before deploying.

Only public Supabase configuration belongs in frontend variables. Set private NVIDIA credentials as Worker secrets; `.dev.vars` is local and gitignored. No deployment or production configuration changes are performed by the source upgrade.

When a new version is deployed, open copies of DMC show "A new version of DMC is ready". The update is never applied in the middle of a session.

## Make a pack

1. In DMC, choose **Make a pack with AI** (or **Add papers** on a pack). Fill in the paper details and copy the prompt.
2. Open any AI chat, attach the question paper PDF (and the mark scheme if you have it), and paste the prompt.
3. Copy the reply, then choose **Import** in DMC and paste it. DMC tidies common formatting slips, checks every question, and shows a preview to compare with the paper. If something is wrong, **Copy fix prompt** gives the AI the exact errors.

The format is documented in [docs/PACK_FORMAT.md](docs/PACK_FORMAT.md), with a JSON Schema in [schema/](schema/). Zips (JSON plus an `images/` folder) and folders import too, and **Export pack** writes the same format for sharing.

Daily 10 is retired. Existing session records remain readable and survive backup, restore and sync; ordinary papers, Random and mistakes drills remain available. Clearing a question from the mistakes bank is a repeat-practice convenience, not proof of topic mastery.

## Your data

Packs, PDFs and progress live in this browser's storage on this device; clearing site data erases them. Signed in, progress, historical question snapshots and pack outlines sync to your account; full paper files and PDF/image assets stay local; your own packs can also be backed up to the account if you choose. Use **Settings > Data > Export everything** regularly; backups are checked with a checksum and merge without deleting anything.

Implementation, compatibility, test coverage and limitations are described in [Upgrade delivery notes](docs/UPGRADE.md).

## Project layout

```
src/lib/engine/   timer, random draw, mistakes bank, grading, session lifecycle
src/lib/stats/    rolling averages, verdict, rushed-error alert, KPIs, dashboard
src/lib/format/   lenient reader, validator, merge, markup, SVG sanitiser, prompts
src/lib/data/     IndexedDB (versioned, with migrations), import, keys, PDFs, backups
src/lib/backend/  Supabase and mock backends behind one typed interface
src/lib/library/  posting, downloading and covers for the school Library
src/lib/sync/     local-first sync
src/lib/pdf/      pdf.js wrapper (lazy)
supabase/         schema.sql: tables, RLS, storage policies (run in the Supabase SQL editor)
tools/            validate-pack.mjs (CLI validator)
src/screens/      library, pack dashboard, question screen, results, settings
src/ui/           design-system components, charts, brand
brand/            builtbyjosef logo files (picked up automatically)
docs/             PACK_FORMAT, PACK_BUILDER_GUIDE, SUPABASE_SETUP, LIBRARY_POLICY, DECISIONS, PROGRESS, reviews
```

Built by Josef Yang. Built to a standard. Built to move.
