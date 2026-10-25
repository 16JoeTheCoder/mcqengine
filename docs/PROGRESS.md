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
- [ ] 4. Supabase auth, library, posting, RLS tests, docs
- [ ] 5. Sync
- [ ] 6. Final review pass, docs, CLAUDE.md
