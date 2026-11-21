# Revision-tool upgrade

Current source upgrade supersedes the historical implementation notes below.

- Daily 10 navigation, creation controls and scheduling are removed. Historical session types remain compatible with replay, backup, restore and sync.
- Ordinary papers, Random and mistakes drills remain available.
- Dashboard summaries describe observed trends with sample size and self-reported-practice caveats. The mistakes-bank rule is not labelled topic mastery.
- Cloudflare replaces Netlify hosting; deployment and environment setup are documented in `CLOUDFLARE_SETUP.md`.
- Email OTP, isolated account/guest databases, legacy quarantine/recovery and shared-device backup/cache removal are implemented.
- CAS sync, deterministic revision pagination, cascading tombstones, split session-pair staging, local conflict export and transactional attempt change tracking are implemented.
- Board mode, persisted presentation size, fullscreen/theme controls, jump, reveal, elimination, revisit and source-page access are implemented. The writing half is an ordinary empty region.
- AI extraction (NVIDIA, Durable Object budget) was built here and removed in Phase 3.
- Reference-filtered bounded backups, worker compression, historical content snapshots and key-correction audit history are implemented.
- Final verification: `npm run check` passed: frontend + Worker typecheck, lint, 301 unit tests in 22 files, production build. All 28 Chromium tests passed, including account A/guest/B/A, guest adoption, shared-device removal, board blank/theme/fullscreen/keyboard/mobile, offline practice and accessibility.
- Worker `wrangler deploy --dry-run` validates the bundle/config without publishing. No real SMTP, Supabase project, DNS or HTTPS smoke was run because credentials/configuration were not supplied.
- See `UPGRADE.md` for implemented behavior, compatibility, known limits, costs and manual setup. Live deployment, production authentication, DNS and data changes still require explicit authorization.

## Historical implementation record

# Progress

Resume from here after a context reset. Each stage ends with `npm run check` green and a commit.
Work happens on branch `claude/cool-thompson-v9r32r` (the brief's "v2" branch; see DECISIONS 110). `main` stays deployable.

## Audit (stage 0, done)

Deployed on Netlify: `npm run build`, publish `dist/`, static, hash routing, hand-written service worker, CSP in `netlify.toml`. Baseline: 186 unit tests and 10 Playwright tests green, typecheck and lint clean.

Already correct and kept as is: absolute-timestamp countdown with monotonic backward-jump guard, hard caps clamped in engine and UI, Submit (partial) / Save (frozen) with one open session per pack enforced in a transaction, Web Locks single active tab, Random least-seen tiers with seen-only-when-answered and lock at creation, two-in-a-row mistakes rule (same day allowed, wrong resets), key snapshot per session, rolling-3 trend with band and true-scale toggle, verdict (4+ sessions, empirical after 6, binomial before, within-noise wording, popover), rushed-error alert (median/MAD over last 8, 4 required, neutral wording, toggle), pace by thirds, per-paper ladder, bank over time, calibration, tolerant intake with strict path errors, fix prompt, prompt generator, Fix this question, SVG allowlist plus `<img>` rendering, backups with checksum and merge by id/updatedAt, offline PWA with update prompt that never swaps code in a session, backup reminder.

## Gap list (what this branch builds)

| # | Gap | Stage |
| --- | --- | --- |
| 1 | Timer bar starts at ink (not status-ok blue) and mixes in OKLCH | 1 |
| 2 | Sessions without a key: Exam paper sessions allowed, stored as awaiting key, regraded automatically when a key is attached or corrected (stats rebuilt by replay) | 1 |
| 3 | Keys from typed string, JSON/TXT file, mark scheme PDF (letter grid to confirm), mark-myself grid | 1, 2 |
| 4 | Grade boundaries per paper; results show marks to the next grade | 1 |
| 5 | Cause tags on wrong answers in review, split on the dashboard | 1 |
| 6 | Daily 10 (spaced 1/3/7/14 days, sized from pace, cap 20), home screen action | 1 |
| 7 | Command palette (Ctrl+K), tab-rise on answers | 3 |
| 8 | Result card (SVG to PNG, Web Share) and personal best moment | 3 |
| 9 | PDFs stored locally: View in PDF, snips (normalised rectangles), bare PDF plus key import | 2 |
| 10 | CLI validator `tools/validate-pack.mjs` sharing the app validator | 2 |
| 11 | Zip guards: path traversal, entry count, real decompressed size (bomb) | 2 |
| 12 | Pack for friends includes PDFs and keys, refuses library-origin packs | 2 |
| 13 | Supabase: auth (school email, personal Google/email), Library (sets, stars, reports, admin), private storage with signed URLs, RLS proven by tests in PGlite | 4 |
| 14 | Sync of small records (sessions, stats, snips, settings) for any signed-in account | 5 |
| 15 | `noindex`, docs (PACK_BUILDER_GUIDE, SUPABASE_SETUP, LIBRARY_POLICY, CLAUDE.md) | 4, 6 |
| 16 | Playwright additions (key later, Daily 10, library mocked, offline), axe, final review | 6 |

## Stages

- [x] 0. Audit and gap list
- [x] 1. Correctness: timer colour, awaiting key and regrade, boundaries, causes, Daily 10 (key dialog, mark scheme reader, View in PDF viewer component added early)
- [x] 2. PDFs, snips, bare PDF import, mark scheme reading, cross-check, CLI validator, zip guards, pack for friends, backups with PDFs
- [x] 3. Result card, personal best, command palette, tab rise on answers, count-up scores
- [x] 4. Supabase auth (two tiers), Library (browse, post with resume, star, report, admin), RLS proven in PGlite, mock backend, SUPABASE_SETUP and LIBRARY_POLICY
- [x] 5. Sync (versions map, pull-push-pull, tombstones, two-device and interruption tests) and opt-in cloud pack backup
- [x] 6. Mistakes notebook, PDF attach for any paper, approximate-timing labels, e2e (Daily 10, Library, key later, PDFs, card), axe both themes, fresh-eyes review (docs/reviews/v2-review.md), README, CLAUDE.md

- [x] 7. Phase 2 (branch `phase-2`, details in log.md and decision.md): unlinking bug fixed (permanent set IDs, canonical paper keys); one Cloudflare Worker with D1 and R2 replaces Supabase; Google sign-in; content-addressed files; set versions and paper registry; CAS sync on D1; nightly backups and file collection; admin panel; PDF practice mode; plainer wording; e2e against the real Worker.

- [x] 8. Phase 3 (branch `phase-3`, plan in docs/PHASE3_PLAN.md, decisions in decision.md): M1 AI import and its stack removed; M2 paper identity by file hash, text fingerprint and cover code (nobody types a key); M3 PDF answering (clear on re-pick, Follow, flags, unanswered warnings); M4 practice feedback colours and accuracy; M5 edit a set's name, subject, description; M6 search everything (local index plus D1 FTS5); M7 profiles (school only, private option, avatars, reports); M8 admin dashboard (overview, users, suspension, quota, audit log, duplicates, file collection dry run). Migration `0003_phase3.sql`.
  Tests added: unit `answer`, `fingerprint`, `set-patch`, `identity` and `library` updates, Worker route tests `worker-papers`, `worker-profiles`, `worker-admin-search`; e2e Phase 3 specs for answering, search, profiles and admin. Removed: `ai-import`, `worker-ai` tests and the AI e2e spec.
  Unverified live: staging deploy still needed for migration 0003, FTS5 on D1, avatar upload and serving, and the Durable Object deletion. Profiles need the school's sign-off before students get them.

## Next

1. Run setup.md on the council Cloudflare account: create the Google OAuth clients (section B), deploy staging, check every flow live (step 8).
2. Copy the pilot from Supabase (setup.md step 9), record the real file sizes in log.md, then deploy production.
3. Apply migration 0003 and deploy Phase 3 to staging (setup.md, "Upgrading an existing deployment to Phase 3"), check profiles, search and admin live, then merge to `main`. Teacher roles, classes and assignments (a later phase) build on the open `role` column.
