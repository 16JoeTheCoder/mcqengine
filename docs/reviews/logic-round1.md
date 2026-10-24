# Logic and data-integrity review, round 1

Scope: engine (`src/lib/engine`), stats (`src/lib/stats`), data layer (`src/lib/data`), session screen lifecycle (`src/screens/session.tsx`), boot recovery (`src/app.tsx`), and the decisions in `docs/DECISIONS.md`. Every formula in the specification was re-derived independently and compared with the code. No source files were changed.

New tests (vitest, all green; `npx vitest run` gives 158 passed):

| File | What it covers |
| --- | --- |
| `tests/unit/audit-engine.test.ts` | Randomised random-engine properties (400 pools), shuffle uniformity, randomised timer clamps (5,000 configs), Countdown under random wall and monotonic clocks (600 runs × 300 steps), mistakes-bank state machine against a spec reference (300 sequences), grading edge cases |
| `tests/unit/audit-stats.test.ts` | Verdict (binomial and empirical) at 1 SE / 2 SE boundaries, rushed detector at exactly z = -1, t = 0.9 m_t, drop = ceil(0.07 N), baseline selection, KPI windows |
| `tests/unit/audit-data.test.ts` | 25 randomised create / answer / save / submit / auto-submit / discard sequences with every stat rebuilt from scratch after each step, races, imports, backups, prototype pollution, large inputs |

Tests named `BUG...` are written with `it.fails(...)`. Each one states the correct behaviour and passes only while the bug exists. I checked each one by running it as a normal `it`: all 14 fail on the intended assertion, never on an incidental error. When a bug is fixed, its `it.fails` will start failing; change it to `it` at that point.

Test-environment note: happy-dom's `Blob` loses its methods when it goes through fake-indexeddb's structured clone, so image bytes could not be read back in tests. `audit-data.test.ts` swaps in Node's `Blob` for that file only. This is not an app bug, but the existing backup round-trip test compares only `blob.size` for this reason.

---

## Findings

### Critical

#### C1. A stale session write after submit un-submits the session, and the next submit grades it twice

- **Where:** `store.saveSessionState` (db.ts) writes blindly. Each `Runner` in `session.tsx` serialises its own writes (Decision 41), but nothing guards against writes from *other* code paths or tabs.
- **Repro test:** `audit-data.test.ts`: "BUG: a stale autosave after submit ...". After one real attempt, every question ends with `attempts = 2` and `timesSeen = 2`.
- **Exact steps in the app:**
  1. Tab A: start an exam session and answer some questions.
  2. Tab B: open DMC. `recoverSessions()` runs on boot and turns tab A's *live* session from `active` into `saved`, because it cannot tell a live session from a crashed one. Tab B then shows the "Resume your session?" prompt for it.
  3. Tab B: click **Submit**. The session is graded and stats and bank events are written. (Submit on the pack page's saved-session banner does the same.)
  4. Tab A: within 5 s the autosave writes `{...initialSummary, status: 'active'}`. This resets `correct`, `partial`, `agg` and `endedAt` and makes the session open again.
  5. Tab A: click **Submit**. `submitSession` sees `active` and grades again.
- **Impact:** `timesSeen`, `attempts` and `missed` are double-counted. One correct, sure answer is applied twice, so it counts as the "two consecutive" needed and the question leaves the mistakes bank after a single real answer, which breaks the bank rule. Random tiers are skewed. The Web Locks guard (Decision 40) protects only the session screen, not the resume prompt, the pack-page submit/discard, Delete pack or `recoverSessions`.
- **Fix:**
  1. Make `saveSessionState` a guarded read-modify-write in one transaction. If the stored summary is `submitted` or `auto-submitted`, or is missing (deleted), refuse the write and return a flag so the Runner can show "This session was finished or discarded elsewhere" and navigate away.
  2. Have `recoverSessions` skip sessions while another tab holds the `dmc-active-session` lock. Use `navigator.locks.query()`, or try the lock with `ifAvailable` and recover only when it is granted.
  3. Have the Runner listen to `onRemoteChange` and re-read its summary's status.
  4. Release the tab lock only after the unmount `persist('saved', true)` promise settles. Today the parent's cleanup releases it immediately, while the final write is still in flight.

### Major

#### M1. Closing or refreshing the tab pauses the exam clock, and remaining time can increase (Decision 31 vs spec)

- **Spec:** remaining time comes from an absolute end timestamp, survives sleep, never increases, and the hard cap applies.
- **Code:** `recoverSessions` drops `endAt` and freezes `remainingMs` from the last persisted tick. The tick is written every 5 s and on `pagehide`, and the `pagehide` write is an async IndexedDB write that is not guaranteed to commit.
- **Steps:** start a 10-minute exam, wait until 3 s after a 5 s persist tick, then refresh. If the `pagehide` write does not land, the clock shows about 3 s more than before the refresh. Repeat at will. Separately, closing the tab for an hour and reopening costs nothing, so the cap can be exceeded without limit.
- **Judgement:** Decision 31 is not sound against the spec. A tab close is not distinguishable from a deliberate pause, and its own claim that remaining time never increases does not hold, because it relies on a best-effort `pagehide` write.
- **Fix:** on recovery, when `endAt` is present, set `remainingMs = max(0, min(remainingMs, endAt - now))`. Auto-submit on open if it reaches 0. If pause-on-close is a product decision, at least use `min(remainingMs, endAt - lastPersistAt...)` so the value can never go up, and record the deviation from the spec explicitly.

#### M2. An auto-submit is treated as a complete attempt (Decision 34 vs spec), and zero-answer auto-submits count as "done"

- **Spec:** submit grades only answered questions, unanswered ones return to the pool, and the session is `partial = true`. The spec makes no exception for the timer.
- **Code:** an auto-submit is `partial: false`. `qualifying()` adds `answered > 0`, so a zero-answer auto-submit stays out of the trend. `isComplete()`, `papersDone()`, `sessionsKpi()` and the ladder have no such check, so the same session counts as a paper done, a session done and a 0% ladder entry.
- **Repro test:** `audit-stats.test.ts`: "BUG: a paper auto-submitted with zero answers counts as done".
- **Further effects:**
  - A session left running in an open tab, or a strict-mode run whose last question times out (`session.tsx` line 243, `finish(true)`), becomes a full-weight low score in the trend, verdict, KPIs and the rushed baseline.
  - Its `timeMs` includes time spent on unanswered questions but is divided by `answered`, which inflates pace.
- **Judgement:** treating an auto-submit as complete is defensible for exam realism, but it contradicts the spec and the code applies it inconsistently.
- **Fix:** agree the rule with the spec owner. Either follow the spec (`partial = answered < total` for every submit), or keep Decision 34 but treat `answered === 0` as not complete everywhere: add `s.answered > 0` to `isComplete`, or mark such sessions partial in `gradeSession`.

#### M3. The engine does not enforce "one saved session per pack" or question locking for paper sessions

- **Repro tests:** `audit-data.test.ts`: "BUG: the engine allows a second open session ..." and "BUG: paper sessions ignore questions locked by another open session".
- **Code:** `createSession` checks locks only for random and drill sessions. Paper sessions take every question of the paper even when a saved session holds some of them, and nothing stops a second open session in a pack. Only the UI's `blocked={!!saved}` prevents this, and that value comes from a snapshot. Multi-tab use (C1), `recoverSessions` and backup restore (M6) can all produce two open sessions in one pack.
- **Fix:** in `createSession`, inside a transaction, refuse with a clear error when the pack already has an `active` or `saved` session (or exclude locked ids for paper sessions as well and refuse if any are locked).

#### M4. Stale writes bring back discarded sessions and sessions of deleted packs as orphans

- **Repro test:** `audit-data.test.ts`: "BUG: a stale autosave after Delete pack or Discard resurrects an orphan open session".
- **Steps:** tab A has a session open; tab B deletes the pack, or discards the session from the resume prompt. Tab A's next tick, `pagehide` or unmount write re-creates `sessions` and `sessionDetail`. The resume prompt then offers a session whose pack no longer exists. Its questions show "could not be loaded", and submitting it writes stats for a deleted pack.
- **Fix:** the same guard as C1(1): refuse writes when the stored summary is missing. Also have `deletePack` and `deleteSession` broadcast, so an open Runner stops.

#### M5. Fixing an answer key after a session leaves the stored score, the bank and the results review disagreeing

- **Repro test:** `audit-data.test.ts`: "BUG: fixing the answer key after a session ...".
- **Code:** `results.tsx` re-grades with the *current* key (overrides applied), and uses that for the review list, the "wrong" filter and rushed errors. The ring, trend, KPIs, verdict and the mistakes bank keep the summary and stats frozen at submit time.
- **Effect:** after correcting a wrong key, a question you answered correctly stays in the mistakes bank, and the results page shows 1/4 in the ring next to a review that marks 2 correct.
- **Fix:** when an override changes `answer`, re-grade the affected finished sessions. Recompute `correct`/`agg` on their summaries and replay that pack's stats and bank from session details (all details are kept, so a deterministic rebuild is possible). At minimum, have the results page use the stored grading and show "key changed since this attempt".

#### M6. Restore does no schema validation; the checksum detects corruption but not tampering

- **Repro tests:** `audit-data.test.ts`: "BUG: restore applies semantically invalid rows ..." and "BUG: image bytes in a backup zip are not verified ...". A passing companion test shows that a structurally invalid row (no key) aborts the whole restore atomically, which is good.
- **Problems:**
  - The checksum is a plain SHA-256 stored next to the data, so anyone who edits a backup can recompute it.
  - Restore then accepts any rows. The test injects a second `saved` session in the same pack with 10 hours left on a 3-minute cap, and `settings.backupEvery = 'never'`.
  - `manifest.tier` is not checked against the stores in the dump, so a "progress" file can carry packs and papers.
  - Image blobs are stored under their claimed id without checking that it is their SHA-256.
  - The Runner also uses the stored `timer.remainingMs` without clamping it to the sanitised `totalMs` (`session.tsx` lines 93 and 105), so a restored or tampered session can run past its cap.
- **Fix:**
  - Validate every restored row with type guards, and drop or report invalid ones.
  - Only accept stores that belong to the manifest's tier.
  - Recompute and compare `sha256(image bytes) === id`.
  - In the Runner, clamp `remainingMs` to `sanitizeTimer(...).totalMs`.
  - Enforce M3 after restore by keeping the newest open session per pack.

#### M7. Restoring a newer copy of a same-id pack orphans papers, which Random still draws

- **Repro test:** `audit-data.test.ts`: "BUG: restoring a newer copy of a same-id pack ...".
- **Cause:** pack ids are title slugs, so the same pack imported on a phone and on a laptop gets the same id. `applyRestore` replaces the pack row when the backup's `updatedAt` is newer, but it only adds papers. Papers the backup lacks stay in the `papers` store, unlisted in `pack.papers` and so invisible on the pack page. `loadPackContent`/`poolOf` read papers by the `packId` index, so Random keeps drawing from them, and the coverage and KPI denominators disagree with the draws.
- **Fix:** when the incoming pack wins, rebuild `pack.papers` as the union of incoming metas and local papers, via `metaOf`. Or merge papers individually and recompute the meta list. In either case, derive the pool from `pack.papers`, not from the index.

### Minor

#### m1. Countdown misses a backward clock jump that cancels out a long tick gap
- **Repro test:** `audit-engine.test.ts`: "BUG: a backward jump that roughly cancels ...".
- **Cause:** the detection uses `dWall < -1000` on its own. In a throttled background tab, a tick 60 s late combined with a 60.5 s backward change gives `dWall = -0.5 s`. That is not detected, and the 60 s that really elapsed are refunded.
- **Fix:** detect relative to the monotonic clock with `if (dWall < dMono - 1000)`, then re-anchor with `endAt = wall + max(0, lastRemaining - dMono)`. Sleep still charges correctly, because then `dWall >= dMono`.
- The randomised tests confirm the other properties: remaining time never increases, never goes below 0, equals initial minus elapsed exactly with honest clocks, and charges sleep.

#### m2. `sanitizeTimer` accepts a negative `perQMs`
- **Repro test:** `audit-engine.test.ts`: "BUG: sanitizeTimer lets a negative perQMs through". The result is a negative session budget.
- It also re-derives nothing from the paper's real cap; it trusts the stored `capMs`.
- **Fix:** `perQMs = clamp(perQMs, 1000, floor(capMs/q/1000)*1000)`. This also matches the spec's floor in seconds; today it floors in ms, which can be up to 999 ms above `floor(cap*60/q)` s. Take the cap from the paper or pack when available.

#### m3. A verdict downgraded by slope disagreement still says "within noise"
- **Repro test:** `audit-stats.test.ts`: "BUG (label) ...".
- **Cause:** Decision 46 drops Medium to Low when the slope disagrees with the window delta. The Low label then reads "Possibly rising, within noise" although `|delta| >= 1 SE`. By the spec's own definition, Low means < 1 SE.
- **Fix:** keep the Low label "within noise" only for `z < 1`. For a downgrade, say for example "Possibly rising; longer-run slope disagrees".

#### m4. Verdict window size and SE do not match the spec (Decision 44)
- **Spec:** at least 4 sessions, and "SE of 3-session mean = that/√3, SE diff = SE_mean·√2".
- **Code:** windows of `k = min(3, floor(n/2))`, so 4 or 5 sessions compare 2 against 2 using SE/√2. A passing test shows a case where the spec reading gives Low and the code gives Medium.
- **The spec is inconsistent here.** With 4 sessions, two 3-session windows must overlap (4,3,2 vs 3,2,1, like the KPI example). For overlapping windows the difference is `(s_n − s_{n−3})/3`, whose SE is `SE_one·√2/3`, not `SE_one/√3·√2`; the spec formula overstates the noise by √3.
- **Judgement:** the code's choice of non-overlapping windows is sound.
- **Fix:** update the spec to non-overlapping k-windows with SE/√k, or switch to overlapping windows with the corrected SE.

#### m5. Empirical noise is detrended (Decision 45), unlike the spec and unlike the trend band
- The spec says "empirical session-score variance". The code uses the residual SD around an OLS line.
- **Passing test:** a steady climb of 0.5, 0.55, ..., 0.75 is High in the code and Medium by the spec (raw SD).
- **Judgement:** detrending is statistically defensible, but it is a deviation, and `trend()` uses the raw `sd()` for its band, so the two views disagree on the same screen. The `trend()` band for the accuracy metric also uses `total` rather than `answered` as N.
- **Fix:** pick one definition and use it in both places, and record it in the spec.

#### m6. A later chunk that declares a larger `questionCount` grows the paper past its count
- **Repro test:** `audit-data.test.ts`: "BUG: a later chunk that declares a larger questionCount ...".
- **Cause:** `mergeDoc` keeps the previous `questionCount` (4) and adds questions 5 and 6. The result has `present = 6 > questionCount = 4`, so `paperReady` is true and a paper session has 6 questions within the cap meant for 4. An answer key must have 4 entries, so questions 5 and 6 can never be keyed by key file.
- **Fix:** in `mergeDoc`, report a conflict when `nq.n > base.questionCount` or `np.questionCount !== prev.questionCount`, unless the wizard sets an override.

#### m7. Concurrent `commitImport` calls into one pack lose a paper from the pack metadata
- **Repro test:** `audit-data.test.ts`: "BUG: two imports committed concurrently ...".
- **Cause:** the pack row is read outside the write transaction, so the last write wins. Both papers stay in the store, but only one is listed. The same race applies between `planImport` and `commitImport` (time-of-check to time-of-use).
- **Fix:** read the pack, merge the metas and write papers and pack in one `readwrite` transaction. Re-plan if the papers changed since planning.

#### m8. Strict per-question mode: the countdown is created in a post-render effect
- **Where:** `session.tsx` lines 199–204 and 238–245. The new `qCountdown` is created in `useEffect([cur])` after `goto()`.
- **Effects:**
  - A tick that runs before the effect (in a background tab, timers and effects are both throttled to about 1 s) still sees the old countdown at ≤ 0 and calls `goto` again, which skips a question with zero time.
  - After a long hidden period, only one question advances and the next one restarts at full budget from "now". Per-question countdowns do not catch up, while the total countdown does.
- **Fix:** create the next `qCountdown` synchronously inside `goto()`, carrying the overrun into the following questions, or document that per-question countdowns pause when the tab is hidden.

#### m9. If `submitSession` throws in `finish()`, the screen is stuck
- **Where:** `session.tsx` lines 165–179. There is no try/catch. `ended.current = true` and `busy` stay set, so Save and Submit are both dead, and the unmount save is skipped because `ended` is true.
- The data survives (the session is still `active` and is recovered on next boot), but the user sees no error.
- **Fix:** wrap the call in try/catch, reset `ended` and `busy`, and show a toast.

#### m10. "Include partial" lets partial sessions into the trend, verdict and KPIs
- `settings.includePartialInTrend` feeds `packAnalytics`. The spec says partial sessions are excluded from the trend, the rushed baseline and "papers done".
- It is opt-in, but it is not documented as a deviation in DECISIONS.
- **Fix:** document it, or limit the option to the raw scatter.

#### m11. KPIs ignore the range and group filters, while the verdict and trend apply them
- **Where:** `dashboard.ts`, where `scoreKpi(sessions, o)` and `paceKpi` read all sessions.
- On the same panel, "last 3" can therefore differ from the trend's last 3.
- **Fix:** compute the KPIs from `q`, or label them "all time".

#### m12. Practice mode has no timer, so the spec's "hard cap per paper" is not applied
- **Fix:** confirm the intent with the spec owner. If the cap applies everywhere, run a silent cap timer in practice mode too.

---

## Decisions reviewed

| # | Verdict |
| --- | --- |
| 30 Standard length, ties go to the longer | Sound; the spec is silent on ties. |
| 31 Recovery freezes time while the app is closed | **Not sound** against the spec (M1). |
| 33 Forward jumps charged; backward re-anchored | Sound in principle; the detection threshold is flawed (m1). |
| 34 Auto-submit is a complete attempt | Contradicts the spec and is applied inconsistently (M2). |
| 35 One saved session per pack | UI only, not enforced in the engine (M3). |
| 36 Drill budget 30–180 s per question | Sound; the spec is silent. |
| 37 Smart random within the lowest tier | Matches the spec. |
| 40 / 41 Web Locks and serialised writes | Correct within one Runner, but not across code paths or tabs (C1, M4). |
| 42 KPI windows (10, 9, 8 vs 9, 8, 7) | Matches the spec example; test passes. |
| 43 Sessions done includes drills | Consistent with "completed sessions". |
| 44 Verdict windows k = min(3, floor(n/2)) | Sound, but the spec must be updated (m4). |
| 45 Detrended residual SD with a half-question floor | Defensible, but a deviation, and inconsistent with the trend band (m5). |
| 46 Slope disagreement lowers confidence | Acceptable addition; label bug (m3). |
| 47 "Flat" below 0.5 SE | Fine; still says "within noise". |
| 49 Rushed baseline excludes drills; fractions × N | Sound. |
| 52 Calibration uses every finished session | Fine. |
| 54 Restore merges by id and updatedAt, never deletes | The pack-level merge orphans papers (M7); no validation (M6). |

## Verified correct (tests pass)

- **Random draws** (400 randomised pools, plain and smart): correct size, no duplicates, never excluded ids, and every question in a lower tier is drawn before any in a higher tier. The order is shuffled uniformly (first slot within ±1.5% of uniform over 20,000 draws).
- **Lifecycle sequences** (25 sequences × 40 steps): after every step, `timesSeen`, `attempts`, `missed` and `inBank` equal a from-scratch replay of the spec. Drills never touch `timesSeen`. Unanswered questions stay unseen. Saved and active sessions lock their questions from random and drill draws. Re-submitting is a no-op.
- **Concurrent submits** of one session (three at once) grade it exactly once.
- **Timers:** no `buildTimer` input exceeds the cap, the per-question maximum is `floor(cap·60/q)`, and the start dialog also clamps.
- **Mistakes bank:** matches the state-machine reference. Note that the spec's "at the most recent attempt" conflicts with "leaves after two consecutive"; the code follows the hysteresis rule, which is the sensible reading.
- **Rushed detector:** exact at all three inclusive boundaries, `ceil(0.07·N)` is right at N = 100 (gives 7, the float epsilon is handled), the MAD branch, the 8-session cap, the 4-session minimum, and exclusion of partial, practice, drill, other-pack and current sessions.
- **Imports:** re-importing identical content gives `identical` with no duplicates; an answers-only key applies later, including to chunks that arrive after the key; a changed question is a conflict.
- **Backups:** "everything" export → wipe → import reproduces an identical state (images by content hash, bank events, a saved session with a frozen timer, overrides, settings), and is idempotent on a second restore. A structurally invalid row aborts the restore with no partial write.
- **Prototype pollution:** `__proto__` and `constructor` keys in imports and backups do not pollute `Object.prototype`; the validator drops unsafe names.
- **Large input:** 200 papers × 100 questions parse in well under 1 s.
- **Stats are keyed by pack:** identical paper ids in two packs never interfere, and locks do not cross packs.
- **Deleting a pack** with a saved session removes its sessions, details, stats, events and overrides in one transaction.
