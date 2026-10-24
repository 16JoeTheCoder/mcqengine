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
31. A session left `active` by a closed tab, crash or refresh becomes `saved` on the next app open, with the remaining time from its last persisted tick (written every 5 s and on `pagehide`). Time while the app was closed is not charged, and remaining time never increases.
32. A refresh on the session screen restores the session directly; the resume prompt covers every other way of opening the app.
33. Clock changes: remaining time comes from an absolute end timestamp. A backward wall-clock jump of more than 1 s re-anchors using the monotonic clock. A forward jump is charged, because it cannot be told apart from laptop sleep, which must be charged.
34. Auto-submit at time zero is a complete attempt (not partial): unanswered questions count against the paper score, like a real exam. They are not graded individually, so they stay unseen for Random and stay out of the mistakes bank.
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
