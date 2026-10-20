# Changelog

## 1.0.0 — 2026-10-20

First release.

- Exam mode (timed, question palette, flags, change answers until the end) and practice
  mode (instant feedback and explanation, answer locks).
- Sessions end by End Session, timer, or all questions answered; unanswered counts as wrong.
- Review: score, time, this session's mistakes, all-time mistakes sorted by times wrong,
  explanation dialog with cause tags (concept, misread, careless) and "view original".
- Retry mistakes as a practice session, most-repeated first.
- Resume an unfinished session after a reload; export/import all data as JSON.
- Packs: built-in list, upload as zip, folder or pack.json (kept in IndexedDB), overlays
  (explanations, topics, answers), validation with readable errors.
- Rendering: snapshot clip windows, typed text/math/figure/table blocks, KaTeX, "redrawn" badge.
- mcqpack v1.0 toolkit: spec, JSON schema, `tools/mcqpack.py` (extract, merge, validate),
  CIE profile, synthetic fixture and sample pack.
- Optional leaderboard: Netlify functions plus Supabase, hidden when no backend answers.
- Security: Content-Security-Policy and headers; pack text always escaped; SVG checks.
