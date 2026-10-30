# CLAUDE.md

DMC (Dynamic Multiple Choice): a local-first PWA for practising multiple-choice exam papers, with an optional Supabase backend for accounts, sync and a school Library. Built to the builtbyjosef design standard (`docs/design/DESIGN.md`, `src/styles/tokens.css`). Update this file whenever conventions or architecture change.

## Stack

TypeScript (strict), Preact 10, Vite 6, IndexedDB via `idb`, fflate (zips), pdfjs-dist (lazy), @supabase/supabase-js (lazy). Hand-written service worker (`src/sw-template.js`). Tests: Vitest (happy-dom, fake-indexeddb, PGlite for SQL), Playwright (Chromium, axe). Hosted on Netlify as static files with hash routing.

## Commands

All from the repository root, in the VS Code terminal or an Ubuntu/WSL terminal. Node 22.

| Command | What |
| --- | --- |
| `npm install` | install dependencies |
| `npm run dev` | dev server at http://localhost:5173 (uses the mock backend unless `.env.local` has Supabase values) |
| `npm run check` | typecheck, lint, unit tests, production build. Run before every commit. |
| `npm test` | unit tests only (includes the RLS tests against `supabase/schema.sql`) |
| `npm run e2e` | Playwright. Builds and serves the plain app on 4173 and a `VITE_BACKEND=mock` build (`dist-mock/`) on 4174 |
| `node tools/validate-pack.mjs <zip/folder/json>` | the app's pack validator on the command line; exit 0 = would import |
| `node scripts/make-demo.mjs <dir>` | synthetic demo packs |

Supabase setup is click-by-click in `docs/SUPABASE_SETUP.md` (browser only). The SQL lives in `supabase/schema.sql`; re-run it in the Supabase SQL Editor after changing it.

## Architecture decisions (why, briefly; full list in docs/DECISIONS.md)

* **Typed packs are the primary path.** An AI agent compiles PDFs into `dmc-pack/1` (docs/PACK_FORMAT.md, docs/PACK_BUILDER_GUIDE.md). Bare PDF plus key is the lighter path, built as a `bare: true` pack so it goes through the same pipeline.
* **One hostile-input pipeline.** Every pack (files, PDFs, Library downloads, synced rows) goes through guarded unzip (path, count, real-byte limits), lenient read, strict validator, merge, one transaction. Text renders through text nodes only; SVG is allowlisted and shown via `<img>`. Never use `innerHTML` (lint rule).
* **Local-first.** IndexedDB is the source of truth. The app works offline and signed out; sync and the Library never block it.
* **Timers use an absolute end timestamp**, never interval counting; a monotonic check refuses backward clock jumps. Every timer is clamped to the paper's hard cap in the engine and the UI.
* **Seen only when answered** in a submitted session; drills and Daily 10 never change seen counts.
* **Partials, drills, Daily 10, practice and sessions awaiting a key are excluded from trends** (`qualifying()` in `src/lib/stats/core.ts`). Verdict: 4+ sessions, empirical variance from 6, binomial before.
* **Rushed alert** uses median and MAD over the last 8 complete exam sessions (4 required).
* **Mistakes bank:** wrong or Unsure enters; two consecutive sure, correct answers clear it, even on the same day; wrong resets. Daily 10 schedules banked questions at 1, 3, 7, 14 days.
* **Stats are a replay of sessions** (`src/lib/engine/regrade.ts`). A key attached or corrected regrades past sessions and rebuilds stats; sync also rebuilds after a pull.
* **Two account tiers.** Anyone may sign in (Google or email link) for sync. The Library is for confirmed `@stjbs.sch.id` emails plus the owner's allowlist, enforced only by RLS and storage policies that read the signed token and `auth.users` (never user metadata). Google's `hd` is a hint. Proven in `tests/unit/rls.test.ts`.
* **The Library is internal to the school** (agreed with the Head of Cambridge): `noindex`, private buckets, 60-second signed URLs, Library packs marked `origin: library` and refused by Pack for friends. A deterrent, not DRM (docs/LIBRARY_POLICY.md).
* **No service-role key in the client, ever.** Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (public). Backend choice: Supabase if both set, mock in dev or with `VITE_BACKEND=mock`, otherwise none.
* **Sync is small records only**, newest write wins per record, per-record version map, resumable cursors. Never PDFs or Library sets.

## Conventions

* Lean code. No new dependency without a written reason in docs/DECISIONS.md; heavy ones load lazily.
* Strict TypeScript; no `any` without need. Match the surrounding code's style and comment density.
* Tokens only: colours via `var(--token)`, never raw hex in components (exported images such as the result card are the one exception, documented). One orange point per view; status is shape + word + colour; 44 px touch targets; respect reduced motion.
* Accessibility: keyboard operable, labelled controls, axe clean (serious and critical) in light and dark; e2e checks this.
* Copy: sentence case, verb-first buttons, no exclamation marks or emoji.
* Tests where being wrong is costly (engine, stats, validator, merge, sync, SQL rules). Fixtures are synthetic only (`tests/fixtures/`); never commit real exam content. `pilot/`, `*.local.*`, `*.dmc.zip`, `.env.local` are ignored.
* Record each non-obvious decision as one line in docs/DECISIONS.md; keep docs/PROGRESS.md current.
* Whenever you tell the user to run something, say exactly where (which terminal, which folder, or which dashboard page).

## Repo map

```
src/app.tsx              shell, routes, top bar, sync triggers, palette
src/lib/engine/          timer, random, mistakes + Daily 10, grading, session lifecycle, regrade/replay
src/lib/stats/           rolling 3, verdict, rushed, KPIs, dashboard
src/lib/format/          lenient reader, validator, merge, markup, SVG, prompts, filename parser,
                         mark-scheme reader, PDF cross-check, check (shared with the CLI)
src/lib/data/            IndexedDB (v2), import, keys, PDFs, bare PDF import, backups, files/zip guards
src/lib/backend/         Backend interface, Supabase implementation, mock (same rules)
src/lib/library/         post (validate, upload, resume), download, default cover
src/lib/sync/            sync engine
src/lib/share/           result card, font embedding
src/lib/pdf/             pdf.js wrapper
src/screens/             pages and dialogs (session, results, pack, school-library, account, notebook…)
src/ui/                  kit, charts, content renderer, brand
supabase/schema.sql      tables, RLS, storage policies
tools/validate-pack.mjs  CLI validator
tests/unit, tests/e2e    Vitest, Playwright
docs/                    PACK_FORMAT, PACK_BUILDER_GUIDE, SUPABASE_SETUP, LIBRARY_POLICY, DECISIONS, PROGRESS, reviews
```

## Known limitations and unverified

* The live Supabase project is not yet created: auth redirects, email links, signed URLs and upload progress are verified only against the mock; the SQL is verified in PGlite with stand-ins for Supabase's auth and storage schemas.
* Only Chromium is tested. Printing the notebook was not tested on paper.
* The study-sheet logo `tab-outline` is not in `brand/`; the light lockup stands in until it is added.
* Resume of a cancelled post is per file, not per byte.
* Pack outlines sync; questions do not. On a second device, practise needs the pack file or a Library download.
