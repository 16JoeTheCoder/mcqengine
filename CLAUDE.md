# CLAUDE.md

DMC (Dynamic Multiple Choice): a local-first PWA for practising multiple-choice exam papers, with an optional Cloudflare backend (one Worker, D1, R2) for Google sign-in, sync and a school Library. Built to the builtbyjosef design standard (`docs/design/DESIGN.md`, `src/styles/tokens.css`). Update this file whenever conventions or architecture change.

## Stack

TypeScript (strict), Preact 10, Vite 6, IndexedDB via `idb`, fflate (zips), pdfjs-dist (lazy). Hand-written service worker (`src/sw-template.js`). One Cloudflare Worker (`worker/`) serves the static app and every `/api/*` route: D1 database (`migrations/`), R2 files, a Durable Object for the AI budget, cron for backups and file collection. No other backend. Tests: Vitest (happy-dom, fake-indexeddb; Worker route tests run the real Worker in workerd through Miniflare), Playwright (Chromium, axe). Deploy and operations: `setup.md`.

## Commands

All from the repository root, in the VS Code terminal or an Ubuntu/WSL terminal. Node 22.

| Command | What |
| --- | --- |
| `npm install` | install dependencies |
| `npm run dev` | dev server at http://localhost:5173 with the in-browser mock backend (same rules as the Worker) |
| `npm run worker:local` | the real Worker with local D1 and R2 at http://localhost:8787 (development sign-in, no Google) |
| `npm run check` | typecheck (app and Worker), lint, unit tests (including the Worker route tests), production build. Run before every commit. |
| `npm test` | unit tests only |
| `npm run e2e` | Playwright. Serves the plain app (`VITE_BACKEND=none`) on 4173 and a `VITE_BACKEND=mock` build (`dist-mock/`) on 4174 |
| `npm run deploy:staging` / `deploy:production` | build and deploy (needs `CLOUDFLARE_API_TOKEN`; follow setup.md) |
| `node scripts/restore-backup.mjs <dir>` | SQL that restores a nightly backup (setup.md, step 11) |
| `node scripts/migrate-supabase.mjs --env staging --dry-run` | the one-time Supabase copy (setup.md, step 9) |
| `node tools/validate-pack.mjs <zip/folder/json>` | the app's pack validator on the command line; exit 0 = would import |
| `node scripts/make-demo.mjs <dir>` | synthetic demo packs |

Cloudflare setup, Google OAuth clients (by hand), migrations, secrets, deploy, migration from Supabase and rollback are all in `setup.md`. Schema changes are new files in `migrations/` (never edit an applied one), applied with `wrangler d1 migrations apply`.

## Architecture decisions (why, briefly; full list in docs/DECISIONS.md)

* **Typed packs are the primary path.** An AI agent compiles PDFs into `dmc-pack/1` (docs/PACK_FORMAT.md, docs/PACK_BUILDER_GUIDE.md). Bare PDF plus key is the lighter path, built as a `bare: true` pack so it goes through the same pipeline.
* **One hostile-input pipeline.** Every pack (files, PDFs, Library downloads, synced rows) goes through guarded unzip (path, count, real-byte limits), lenient read, strict validator, merge, one transaction. Text renders through text nodes only; SVG is allowlisted and shown via `<img>`. Never use `innerHTML` (lint rule).
* **Local-first.** IndexedDB is the source of truth. The app works offline and signed out; sync and the Library never block it.
* **Timers use an absolute end timestamp**, never interval counting; a monotonic check refuses backward clock jumps. Every timer is clamped to the paper's hard cap in the engine and the UI.
* **Seen only when answered** in a submitted session; drills and historical Daily 10 sessions never change seen counts.
* **Partials, drills, Daily 10, practice and sessions awaiting a key are excluded from trends** (`qualifying()` in `src/lib/stats/core.ts`). Observed trend: 4+ sessions, empirical variation from 6, binomial before; no statistical-confidence claims.
* **Rushed alert** uses median and MAD over the last 8 complete exam sessions (4 required).
* **Mistakes bank:** wrong or Unsure enters; two consecutive sure, correct answers clear it, even on the same day; wrong resets. Daily 10 is retired: keep legacy types and records readable but never create new sessions or schedule questions. Clearing a repeated question is not proof of topic mastery.
* **Stats are a replay of sessions** (`src/lib/engine/regrade.ts`). A key attached or corrected regrades past sessions and rebuilds stats; sync also rebuilds after a pull.
* **Two account tiers.** Anyone may sign in with Google for sync. The Library is for verified school Google accounts (email domain in `library_domains` *and* a matching `hd` claim) plus the admin-managed allowlist and admins. Decided only in the Worker (`worker/auth.ts` `accessOf`) for every request; the app only reads `/api/me`. Proven in `tests/unit/worker-access.test.ts` (the port of the old RLS tests).
* **Sessions:** Google OAuth code + PKCE in the Worker, ID token verified against Google's JWKS (sig, iss, aud, exp, iat, nonce, email_verified). A random token in an `__Host-` HttpOnly, Secure, SameSite=Lax cookie; D1 stores only its SHA-256; rolling 30-day idle, 90-day absolute. Writes need `X-DMC: 1` and a same-site Origin.
* **Identity:** a paper set has a permanent `setId` (UUID) carried by export, import, post, download and sync; never match by title. Papers match by canonical Cambridge key (`9702_s24_qp_12`, `shared/paper-key.ts`) from file names or cover text, never from an AI-written id; question ID = key + `#n`; content hash separates same from edited (keep mine / use the Library's). Rules in `src/lib/format/identity.ts`.
* **Library files are content-addressed:** R2 `blobs/<sha256>`, uploaded once (client checks which hashes are missing), verified by R2's SHA-256 check and magic bytes, served only through the Worker after an access check. A set version is a small manifest (`shared/manifest.ts`); the two newest versions are kept; unreferenced files are deleted 7 days after orphaning by the cron.
* **The Library is internal to the school** (agreed with the Head of Cambridge): `noindex`, private R2 with no public URL, Library sets marked `origin: library` and refused by Share with friends. A deterrent, not DRM (docs/LIBRARY_POLICY.md).
* **No secret in the client, ever.** NVIDIA key, Google client secret and session secret are Worker secrets. Backend choice at build time: `VITE_BACKEND` = `cloudflare` (default in production builds), `mock` (default on the dev server) or `none`.
* **AI:** the browser sends only a task name and inputs; the Worker attaches the versioned prompt (`shared/prompts.ts`), queues under a shared 38/min cap in one Durable Object (position streamed as NDJSON), checks replies with the task rules and the pack validator, and repairs once.
* **Sync uses compare-and-set writes** (one D1 batch per push; a stale base fails the whole batch), a monotonic revision counter and atomic session-pair staging. On by default for school accounts, off for personal ones (per device, Settings). Finished-session snapshots sync, PDF/image bytes do not.
* **Backups:** nightly at 00:00 Asia/Jakarta, every D1 table as gzipped JSONL in R2 (7 daily, 4 weekly); restore with `scripts/restore-backup.mjs`. D1 Time Travel is the second net.
* **Practice modes:** per paper session, DMC mode (typed questions) or PDF mode (the printed paper beside an answer sheet), same question IDs, grading and stats. Papers without typed questions are PDF only; Random and the drill use typed questions.

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
src/lib/engine/          timer, random, mistakes + legacy session compatibility, grading, session lifecycle, regrade/replay
src/lib/stats/           rolling 3, verdict, rushed, KPIs, dashboard
src/lib/format/          lenient reader, validator, merge, markup, SVG, prompts, filename parser,
                         mark-scheme reader, PDF cross-check, check (shared with the CLI)
src/lib/data/            IndexedDB (v2), import, keys, PDFs, bare PDF import, backups, files/zip guards
src/lib/backend/         Backend interface, Cloudflare client, mock (same rules)
src/lib/library/         post (key table, hashed upload, resume), download (update in place), default cover
src/lib/sync/            CAS sync engine, transactional attempt change tracking, per-device sync switch
worker/                 the Worker: auth, library, blobs, sync, ai (+ AiBudget DO), admin, backup, router
migrations/             D1 schema and seed (wrangler d1 migrations)
shared/                 shared by app and Worker: AI protocol, prompt registry, paper keys, set manifest
src/lib/share/           result card, font embedding
src/lib/pdf/             pdf.js wrapper
src/screens/             pages and dialogs (session incl. PDF mode, results, pack, school-library, admin, account, notebook…)
src/ui/                  kit, charts, content renderer, brand
tools/validate-pack.mjs  CLI validator
scripts/                 demo packs, restore-backup, migrate-supabase
tests/unit, tests/e2e    Vitest, Playwright
docs/                    PACK_FORMAT, PACK_BUILDER_GUIDE, LIBRARY_POLICY, DECISIONS, PROGRESS, reviews
setup.md, decision.md, log.md   deploy runbook; Phase 2 decisions; build log
```

## Known limitations and unverified

* Not yet deployed: staging and production need the council account's API token and the Google OAuth clients (setup.md). Google sign-in is verified against a fake Google (real RS256 signatures, PKCE, JWKS) in the Worker tests, not against Google itself.
* Workers Rate Limiting bindings and the Cache API are not exercised by the local tests (absent in Miniflare's default config); their code paths are no-ops when the binding is missing.
* Only Chromium is tested. Printing the notebook was not tested on paper.
* The study-sheet logo `tab-outline` is not in `brand/`; the light lockup stands in until it is added.
* Resume of a post is per file, not per byte.
* Pack outlines and historical answered-content snapshots sync; full paper content and PDF/image assets do not. A second device needs an import or Library download to practise.
