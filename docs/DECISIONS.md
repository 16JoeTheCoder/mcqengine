# Decisions

One line each: what was decided and why. Grouped by area.

## Audit of the old repository (deployment only)

1. Host: Netlify. The old `netlify.toml` published the repo root (`publish = "."`) with no build command, and served functions from `netlify/functions`. No CI workflow existed in the repo; Netlify built on push.
2. Base path: root of the Netlify site; the old app used relative URLs. The old CSP and security headers are kept, extended for the service worker, manifest and fonts.
3. The leaderboard (`netlify/functions/leaderboard.js`, `submit-score.js`, `docs/leaderboard.sql`, needing Supabase) was deleted with the rest. It is in git history at commit `631ffa4` if you build the Supabase version later.
4. New deploy: Netlify runs `npm run build` and publishes `dist/` (see `netlify.toml`). Vite builds with `base: './'` and hash routing, so the same build works on any static host under any base path.

## Design

5. The brief's "Astra" design (dark only, glass, star field, violet and cyan) is replaced by the builtbyjosef design standard, at the user's later instruction: tokens from `tokens.css`, Space Grotesk and JetBrains Mono, flat with 10 px radius, one orange point per view, status as shape + word + colour. The standard is copied to `docs/design/`.
6. Light and dark themes both ship (the standard defines both); the theme follows the OS, with a System/Light/Dark setting. `color-scheme` follows the theme.
7. Space Grotesk has no Greek glyphs, so Inter's Greek subset is registered under the same family name with a Greek `unicode-range`. Physics needs λ, Ω, μ to match the surrounding text.
8. KPI units are ink-muted, not orange, so the one orange point per view stays the primary action.
9. Timer bar colours use the status tokens (ok blue, then warn amber, then bad red), mixed in OKLCH with `color-mix`. In the last 10% it adds stripes and a pulse, so the warning never relies on colour alone.
10. Unsure uses the warn token with a triangle shape; Flag uses ink with a flag shape. Practice feedback is "Correct" (ok, circle) and "Incorrect" (bad, diamond).
11. Selected answers use ink fill with the orange cap (the Tab form), so your choice is the orange point on the question screen.
12. Max content width is the standard's 1200 px. Above 2200 px the whole layout is zoomed 1.25× so 2560 px never looks sparse.
13. "Reduce effects" now turns off motion (draw-in, counters, lifts), because the standard has no glows or star field to disable.
14. The builtbyjosef signature: lockup at 40 px (the standard's minimum) in the top bar and footer, 96 px in About. Files are read from `/brand` at build time; `*-light` files are for light grounds and `*-dark` for dark grounds, as in the standard. A text placeholder renders until files exist.
15. The DMC mark is a Tab (72 × 128, corner 10, orange cap) holding three answer bars, the middle one chosen, in keeping with "everything is a Tab".
16. Icons are inlined Lucide paths (2 px stroke) instead of a dependency.

## Stack

17. TypeScript (strict), Vite 6, Preact 10 (4 KB), `idb` (1 KB) and `fflate` (loaded only for zip import and export). No dependency over 20 KB gzipped ships to the browser.
18. Hash routing (`#/pack/id`): works on any static host and base path with no rewrite rules.
19. The service worker is hand-written (`src/sw-template.js`); a tiny Vite plugin injects the precache list and a content-hash version. vite-plugin-pwa would add a Workbox build step for no gain here.
20. The validator is hand-written for path-based, human messages. The published JSON Schema is checked against valid fixtures in tests with Ajv (dev only), so the two cannot drift silently.
21. Initial JavaScript is 54 KB gzipped. Library, pack page and the question screen load up front, since they are the practice loop; import, prompt, insights, results and settings are split out and load on demand.

## Pack format

22. The markup is a LaTeX subset (`^{}`, `_{}`, `\frac`, `\sqrt`, `**bold**`) because LLMs already write it fluently. No maths library: KaTeX would add about 280 KB for features MCQs do not need.
23. Paper ids are slugs that the prompt supplies, so re-imports merge by id. Question ids are `<paper id>#<n>`, and a content hash detects identical re-imports and conflicts.
24. Unescaped LaTeX backslashes are repaired only for command names that collide with JSON escapes (`\frac`, `\theta`, `\beta`, `\rho`, `\nu`, `\times`…), so real `\n` line breaks still work.
25. A missing image file becomes a "needs figure" placeholder (warning), not an error, so one missing screenshot never blocks a whole import. A missing whole-question screenshot is an error, because the question would have no content.
26. Answer keys are remembered on the paper (`pendingKey`), so chunks that arrive after the key are keyed on arrival.
27. The wizard requires a time cap for every paper before import, because every timer is clamped to it.
28. Exported packs apply the user's fixes. Re-importing such an export into the same pack is recognised as identical by also hashing "original plus override".
29. SVG is sanitised with an allowlist and then rendered through `<img>`, where it cannot run script or load resources: two independent barriers.

## Session engine

30. Standard paper length = the most common paper question count in the pack; ties go to the longer length. Random and drill sessions use it, or the whole pool if smaller.
31. A session left `active` by a closed tab, crash or refresh becomes `saved` on the next app open, with the remaining time from its last persisted tick (written every 2 s and on `pagehide`). Time while the app was closed is not charged, so a closed tab acts like Save. The logic audit flagged this as a way to pause the clock; it is kept on purpose, because charging closed time would auto-submit a paper the moment a laptop is reopened days later, and this is self-practice. The heartbeat bounds the refund to 2 s. Recovery is skipped while another tab holds the session lock.
32. A refresh on the session screen restores the session directly; the resume prompt covers every other way of opening the app.
33. Clock changes: remaining time comes from an absolute end timestamp. A backward wall-clock jump of more than 1 s re-anchors using the monotonic clock. A forward jump is charged, because it cannot be told apart from laptop sleep, which must be charged.
34. Auto-submit at time zero is a complete attempt (not partial): unanswered questions count against the paper score, like a real exam. They are not graded individually, so they stay unseen for Random and stay out of the mistakes bank. The brief's partial rule covers manual Submit only. Excluding time-outs from the trend would hide exactly the time pressure the trend should show. Exception: an auto-submit with nothing answered is partial, and every completeness check requires at least one answer.
35. Starting a new session in a pack that has a saved session is blocked until the saved one is resumed, submitted or discarded (one saved session per pack). The random engine also excludes locked questions, and this is tested.
36. Drill time budget: the pack's average budget per question, clamped to 30–180 s per question. Exam-mode drills always have a timer, so "No limit" is not offered for drills.
37. Smart random ships behind its switch, off by default. It uses weighted sampling without replacement inside the lowest tier only (wrong +2, Unsure +1), and has unit tests for both the bias and tier order.
38. Practice mode checks and locks an answer on first click, so "Unsure" cannot be toggled after checking.
39. "Confirm before submitting" off means Finish on the last question submits at once when everything is answered; the End session dialog is unchanged.
40. One active session across tabs uses the Web Locks API; a second tab shows a clear notice. Data changes are broadcast so other tabs refresh.
41. Session writes are serialised and blocked once a session ends, so a late autosave can never overwrite Save or Submit. This race was found by the end-to-end tests.

## Analytics

42. "Paper score" KPI delta follows the brief's worked example: the last-3 mean against the 3-session window one step earlier (10, 9, 8 against 9, 8, 7). Pace uses the same windows.
43. "Sessions done" counts every completed (non-partial) session, drills included; the trend counts only qualifying sessions.
44. Verdict windows: k = min(3, floor(n / 2)), so 4 or 5 sessions compare 2 against 2, and 6 or more compare 3 against 3.
45. Verdict noise with 6+ sessions: the residual SD around an OLS line over the last 10 sessions. This is the empirical session-score variance, detrended so a real trend is not counted as noise. It is floored at half a question.
46. If the 10-session slope disagrees in sign with the window delta, confidence drops one level and the sentence says so.
47. "Flat" is used when |delta| < 0.5 SE; otherwise a Low result reads "Possibly rising/falling, within noise".
48. Projection: latest 3-session mean plus the OLS slope per day, halved and applied to at most 21 days, with an 80% interval. It needs 5 sessions, shows only with an exam date, and can be turned off.
49. Rushed-error baseline excludes drills (different difficulty). Comparisons use paper score fractions times the current paper's N, so papers of different lengths can share a baseline.
50. Dashboards read only session summary rows. Thirds, calibration, answer changes, the slowest-quarter split and the time histogram are precomputed at submit.
51. A paper is "Weak" when its latest complete attempt scored under 60%.
52. Calibration and answer-change analytics use every finished session (more data, same meaning); trend and pace views use qualifying sessions.

## Data

53. The exam date is a global setting, since one student usually has one exam per pack season.
54. Backups: progress tier is JSON; packs and everything tiers are zips with a manifest and a SHA-256 checksum of the data. Restore merges by id and `updatedAt` (question stats by last answer time) and never deletes.
55. Wipe all, and delete pack, need a typed confirmation (ERASE, DELETE).
56. Persistent storage is requested on first open.

## Changes after the logic audit (round 1)

57. Session writes go through `persistOpenSession`, which refuses inside the transaction when the session is gone or finished. A stale tab can therefore never un-submit, double-grade or resurrect a session. The session lock is released only after the screen's final write.
58. "One open session per pack" is enforced in `createSession`, not only in the UI, so paper sessions can never share questions with a saved random session.
59. Every submitted session stores the answer key it was graded with (`detail.key`). Reviews and the rushed-error list grade against that snapshot, so a later "Fix this question" never makes a past result disagree with its stored score. Fixes apply to future sessions only.
60. Restores reject the whole backup if any row fails shape checks (a valid checksum on invalid data means tampering). They apply only the stores the tier declares, clamp timers, verify image bytes against their SHA-256 ids, and keep one open session per pack. A same-id pack keeps the union of both copies' papers.
61. New pack ids carry a short random suffix, so the same title imported on two devices never collides in a backup.
62. A chunk that declares a different `questionCount` than the stored paper is a conflict unless the count is edited in the review table. Imports update the pack inside one transaction.
63. The session screen re-derives the hard cap from the pack on every load, so stored or restored timer data can never exceed it.
64. The clock check compares wall-clock elapsed against monotonic elapsed, so a backward clock change is detected even when it coincides with a long throttled gap.
65. The trend band uses the same noise model as the verdict: residual scatter around the trend line with 6+ sessions.
66. Known limits, kept: verdict windows are 2 vs 2 with 4–5 sessions (the brief's 3-session SE implies overlapping windows that overstate noise). KPIs follow their own definitions and ignore the trend's range filter. "Include partial" affects trend, verdict and KPIs together. Practice mode is untimed and so has no cap. In strict per-question mode, a hidden tab advances at most one question per timer tick until it is visible again.

## Changes after the design and UX reviews (round 1)

67. In an Exam, "Fix this question" hides and locks the answer key (otherwise it leaks the answer and can be used to score a question). Text, figures and reports stay editable; the key is fixed after submitting.
68. End session opens with focus on "Keep going", so two Enter presses can never submit by accident.
69. A failed save (storage full) keeps the session open and says so; Save and Submit never report success they did not achieve.
70. Pasted import JSON and the prompt dialog's fields survive closing the dialog, until an import succeeds.
71. Route changes move focus to the new page's main region; question changes are announced politely ("Question 7 of 40"). Timer announcements stay at 50%, 25%, 10% and 1 minute.
72. Answer options use roving focus: Up/Down move between options, Space/Enter choose, Left/Right stay question navigation (they are the exam's primary keys).
73. Answered cells in the question grid use the inverse fill (3:1 or better in both themes); the current cell has an ink ring.
74. The timer bar mixes colours in sRGB, not OKLCH: OKLCH hue interpolation passed through magenta or green between blue and amber. The bar still drains from the left, as the brief specifies; the low state adds stripes, a pulse and a "Low" word.
75. The service worker never reloads the page on first install; it reloads only after the user accepts an update.
76. Only one orange point on the question screen: the selected answer's cap. Next and Finish are plain buttons there.
77. A wrong selected answer in Practice reverts to the raised surface, so its red border keeps contrast.
78. Toasts show at most three at once, sit at the top on the question screen (never over Previous/Next), and errors stay longer.
79. Recorded session time is capped at the session budget (a sleep past time zero is not time spent).
80. "No limit" is renamed "Full time (N min)", because the cap always applies.
81. Hover lifts are limited to hover-capable pointers; the cap sweep exits with ease-in at 60% duration.
82. At 2200 px and wider the layout still zooms 1.25×. Full-height layouts divide their viewport units by the zoom, so the question screen and modals fit.
83. Known minor design items kept: nested radii of 7 px inside 10 px segmented controls (concentric with the 3 px inset), 14 px text in tabs and tables, and no modal exit animation. Each costs more code than it returns.
