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
