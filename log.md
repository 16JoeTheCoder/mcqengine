# Phase 2 build log

Running progress log for the Phase 2 move to Cloudflare. Newest entries at the bottom of each section. Decisions are in [decision.md](decision.md); long-term ones in [docs/DECISIONS.md](docs/DECISIONS.md).

## Plan (milestones, in order)

1. **Root cause of the unlinking bug** and a regression test that fails on the old code.
2. **Identity model** on the client: permanent set ID carried by export, import, post, download and sync; set versions; canonical Cambridge paper keys; question ID = key + `#n`; content-hash matching rules (unit-tested).
3. **Worker foundation**: D1 migrations, router, input validation, errors, health, client-error, observability. Route tests run the real Worker in Miniflare (workerd) with real D1, R2 and Durable Objects.
4. **Auth**: Google OAuth code + PKCE, JWKS-verified ID token, hashed rolling session cookies, membership (`hd` + domain, or allowlist), admins, display names.
5. **Library on D1 + R2**: sets, versions, manifests, paper registry, content-addressed blobs (check, streamed verified upload, ranged cached download), quotas, rate limits, stars, reports, moderation, refcount GC cron.
6. **Sync** ported to D1 with the same compare-and-set behaviour; existing sync tests run against the Worker.
7. **AI**: server prompt registry, pack-validator check with one repair retry, queued shared limit (38/min) with queue position, daily allowance, admin AI status and test key.
8. **Backups**: nightly gzipped JSONL dump, 7 daily + 4 weekly retention, tested restore script.
9. **Client**: `cloudflare` backend, mock updated to the same interface, Supabase removed; Google sign-in UI; sync toggle; post/download/update flows; admin panel; practice modes (DMC / PDF).
10. **UX fixes** with `/impeccable`; axe light and dark.
11. **Supabase migration script**, `setup.md`, docs (CLAUDE.md, README, LIBRARY_POLICY), PR.

## Progress

- Read the required files. Baseline `npm run check` passes on `main` code.
- The Cloudflare tools attached to this session reach a different account (two unrelated D1 databases), not the council account `e82975af…`. Nothing was created there. Staging deploy needs the owner's API token (see Blocked).

## Blocked / needs the owner

- Live staging deploy and live browser checks: no Cloudflare API token for the council account in this session, and the Google OAuth client must be created by hand. `setup.md` covers both.
- Live Supabase export: needs the service-role key on the owner's machine (`scripts/migrate-supabase.mjs`).

## Pilot file sizes

Not measured yet: the pilot's files live in Supabase storage, which this session cannot read. The migration script prints a size summary (count, total, largest, median per type) when it runs; paste it here.

### Milestone 1–2: unlinking bug and identity (done)

- Regression test `tests/unit/unlinking.test.ts` written first; on the old code all three failed: post-then-download left 2 packs; export-then-import made `re-import-5g4b2h` beside `synthetic-physics-1f4g1g`; one Cambridge paper under two AI ids became 2 papers. All pass now.
- Added `shared/paper-key.ts`, `src/lib/format/identity.ts`, `pack.setId`, `paper.paperKey`, set-ID targeting in the importer, `prefer` in merge. 35 identity tests (`tests/unit/identity.test.ts`).
- Next: Worker foundation (D1 migrations, router, Miniflare route tests).

### Milestone 3–9 (core): Worker, auth, Library on D1 + R2, sync, AI, backups, client (done)

- Worker modules in `worker/`: auth (Google OAuth + PKCE, JWKS, hashed rolling sessions), library (sets, versions, registry, stars, reports), blobs (verified streamed upload, ranged cached download, quotas, rate limits), sync (CAS port), ai (prompt registry, queue, repair), backup (nightly gz JSONL, retention, GC), admin.
- D1 schema in `migrations/0001_init.sql`, seed in `0002_seed.sql`.
- Tests run the real Worker in workerd via Miniflare (`tests/unit/worker-harness.ts`): 182 route tests across access rules (port of the RLS tests), blobs, auth, AI, backup/restore. The existing sync scenarios also run against the Worker.
- Subagent tests found one product bug: workerd rejects `fetch(..., { redirect: 'error' })`, so every NVIDIA call failed. Fixed (`redirect: 'manual'`, 3xx is a failure).
- Client: `src/lib/backend/cloudflare.ts`, mock rewritten to the same interface, Supabase removed (code, schema, PGlite RLS test, dependency). Library post/download rewritten for manifests and hashed files; sync on/off per device.
- Next: admin panel, practice modes (PDF mode), pack empty state, copy changes, accessibility fixes, e2e against the local Worker, setup.md, migration script, docs.

### Milestone 9–11: client, UX, docs, verification (done)

- Admin panel (`#/admin`), PDF practice mode, sync switch, paper-set wording, Advanced section in the make-a-set dialog, first-visit paper-set screen, More menu on set cards, stepped post progress, paper-key table in the post dialog and the import review.
- `setup.md` (deploy, Google OAuth by hand, migration, rollback, restore), `scripts/migrate-supabase.mjs` (tested end to end against the Worker), `scripts/restore-backup.mjs` (tested round trip), CLAUDE.md, README, LIBRARY_POLICY, docs/DECISIONS.md, docs/PROGRESS.md updated.
- New e2e project against the real Worker (`wrangler dev --env local`, local D1/R2): post PDFs, download as another student, PDF mode, version 2, Update available, admin panel, backup, axe light/dark. Found and fixed: Cambridge-named PDFs posted from files lost their names (keys had to be confirmed by hand); the PDF page pane was not keyboard-scrollable (axe).
- Design pass (`/impeccable`, screenshots at 390 and 1440 px, then 800 px for the breadcrumb): fixed the phone post dialog (cover pushed the papers table off screen), a CSS rule that hid the third column of every table on phones, and Escape in AI import leaving the import dialog open (the reported "dialog stays after Escape"). Teacher walkthrough: posting PDFs straight from files publishes no key; the dialog now says so and points to the confirmed-key path. Detector hits (Space Grotesk; the 4 px orange cap) are the pinned brand and stay.
- Also found while wiring the import review: `planImport` renamed paper ids on the caller's document; it now plans a copy.
- Results: `npm run check` passes (520 unit tests, including 182 Worker route tests and the sync scenarios against the Worker); Playwright 32/32 across the plain app, the mock backend and the real local Worker.

### Still open

- Live staging and production (needs the council account token and the Google OAuth clients; setup.md is ready).
- Pilot file sizes (printed by the migration dry run; paste above).
- Workers Rate Limiting bindings and the Cache API path run only on Cloudflare; locally they are no-ops.

## Phase 3 (branch `phase-3`)

Plan: [docs/PHASE3_PLAN.md](docs/PHASE3_PLAN.md). Decisions: decision.md, section "Phase 3". The AI import described under Phase 2 (milestone 7 above) was removed in M1.

- M1 removed AI import, `worker/ai.ts`, the prompt registry, the NVIDIA settings and the `AiBudget` Durable Object (wrangler migration `v2-remove-ai`).
- M2 paper identity: file hash, then MinHash text fingerprint (`shared/fingerprint.ts`, `src/lib/pdf/identity.ts`), then the Cambridge code. `paper_prints` table; `POST /api/papers/match`. No typed keys.
- M3 and M4 answering and practice: `src/lib/engine/answer.ts`, Follow, flags, unanswered warnings, practice colours and accuracy.
- M5 edit a set (`src/screens/edit-set.tsx`); `PATCH /api/sets/<id>` takes `subject`.
- M6 search: local index plus D1 FTS5 (`worker/search.ts`, `src/lib/search.ts`, palette).
- M7 profiles: `worker/profiles.ts`, `src/screens/profile.tsx`, avatars in R2.
- M8 admin dashboard: overview, users, audit log, duplicates, file collection dry run (`worker/admin.ts`, `src/screens/admin.tsx`).
- Tests added: unit `answer`, `fingerprint`, `set-patch`, `worker-papers`, `worker-profiles`, `worker-admin-search` (plus updates to `identity`, `library`); Playwright Phase 3 specs. Removed the AI unit and e2e tests. Test harness splits migrations on `END;` so trigger bodies apply.
- Not verified live: migration 0003, FTS5 on real D1, avatar upload and serving, and the Durable Object deletion all need the staging deploy (setup.md, "Upgrading an existing deployment to Phase 3"). Profiles need school sign-off before release.
