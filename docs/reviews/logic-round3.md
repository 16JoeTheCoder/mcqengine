# Logic and data-integrity review, round 3 (final)

This round covers branch `ccr-7d4756bd-86dw39` at `d9474e9`. I verified R1–R12 and attacked the new code:

- `db.createOpenSession`
- the question-level merge in `commitImport`
- the paper merge in `applyRestore`, plus the `touchedPacks` recompute, `cleanSettings` and the deeper `validRow`
- the navigation after a refused save, `autoFailed`, and the deferred lock release in `session.tsx`
- the Fix dialog on the results page

No source files were changed.

New test file: `tests/unit/audit-round3.test.ts`, 10 tests.
- **Regression checks (4 pass):** R1 with three concurrent starts, R5b under forced suffix collisions, R3 with meta recompute, and submitting a discarded session.
- **Real bugs (6 `it.fails`):** run as a plain `it`, each one fails on its intended assertion.

The suite is green at 180 tests, and `tsc` and `eslint` are clean.

## Round-2 findings

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| R1 | Concurrent starts in one pack | **Fixed** | `createOpenSession` checks and writes in one transaction. Test: of three concurrent starts, exactly one succeeds. |
| R2 | Lock released before the final save | **Fixed** | `setTimeout(0)` runs after the child Runner's synchronous unmount cleanup has queued its write; then `finalWrite.then(release)`. |
| R3 | Newer backup paper loses local questions | **Fixed** (newer direction) | Local-only questions are kept and pack metas are recomputed (test). The opposite direction is not handled; see N1. |
| R4 | Shallow restore validation | **Partly** | Question rows, stat and override keys and settings are checked now. Gaps remain: N3, N4, N5, N6. |
| R5a | Stale plan drops a chunk | **Fixed** (added questions) | Stored questions missing from the plan are kept. A stale plan still overwrites questions it does carry; see N2. |
| R5b | Suffix collision overwrites a pack | **Fixed** | 6-character suffix plus a counter loop inside the transaction (test with forced zero randomness). |
| R6 | Refused save leaves a dead screen | **Partly** | Autosave refusals now toast and navigate. `saveForLater` and `finish` set `ended` *before* their write, so on a refusal the new branch skips its message. `saveForLater` then still shows "Session saved", and `finish` on a discarded session goes to "Results not found" (`submitSession` returns `null`, test). See N7. |
| R7 | Delete pack ignores the lock | **Fixed** | `del()` checks `sessionLockHeld()`. |
| R8 | Key-fix flow after an exam | **Fixed / kept** | The results page now has Fix plus a note that the result keeps its graded key. Bank and stats are not rewritten (kept, D91). Pre-snapshot sessions are not backfilled and still re-grade with the current key (Minor, unchanged). |
| R9 | Per-question floor of 1 ms | **Fixed** | At least 1 s per question, unless the cap itself allows less. |
| R10 | Zero-width trend band | **Fixed** | Floor of `0.5/N` for score and accuracy. |
| R11 | Auto-submit retried every tick | **Fixed** | Gated by `autoFailed`. Residual issue: N8. |
| R12 | Same-tab lock, stale actives, cap shrink | **Partly** | Cap shrink is fixed (D90). Stale actives stay unrecovered while a lock is held (kept, D91). `sessionLockHeld()` still counts this tab's own lock (not fixed), so after refreshing the session screen, the resume prompt refuses Submit and Discard for other packs' saved sessions with "running in another tab". |

## New findings

### Major

**N1. Restoring an older backup never merges in questions that only the backup has** (`it.fails`: "an OLDER backup copy of a paper ...").
- Decision 86 says restores merge papers at question level, but `applyRestore` takes an incoming paper only when it is new or its pack wins (`take = !have || winners.has('pack:…')`).
- **Steps:**
  1. This device holds `p1` with 2 questions and has the newer pack row, because any Fix bumps `pack.updatedAt`.
  2. It restores a backup whose `p1` has all 4 questions but whose pack row is older.
  3. `p1` stays at 2 questions. Chunk 2 from the backup is silently dropped.
- This is the mirror image of R3.
- **Fix:** for every incoming paper that already exists locally, take the union of questions by `n` regardless of which pack row won. Prefer the winner's copy when the same `n` appears in both, then recompute `metaOf` and add the pack to `touchedPacks`.

**N2. A stale import plan overwrites an answer key that was applied after it was planned** (`it.fails`: "a stale plan that covers already-stored questions ...").
- `commitImport` keeps only stored questions *missing* from the plan. For every question the plan carries, its planning-time copy wins.
- **Steps:**
  1. Tab 1 plans an identical re-import of `p1`.
  2. Tab 2 plans and commits the answer key.
  3. Tab 1 commits.
  4. `p1` drops from `keyed: 4` to `keyed: 0`, and the paper can no longer be started.
- Content edits are not at risk here, because content conflicts are caught at plan time; the problem is the answers that the plan's copy predates.
- **Fix:** inside the commit transaction, re-run the merge rules against the stored paper. Keep a stored non-null `answer` when the planned copy has `null`, and treat stored ≠ planned answers as a conflict. Or store a paper version, refuse a stale plan, and re-plan.

**N3. A restored session timer with a non-numeric cap becomes NaN, so the clock never reaches zero** (`it.fails`: "a non-numeric timer cap ...").
- `validRow` does not check timer fields.
- In `clampTimer`, `sanitizeTimer` computes `Math.max(60_000, 'lots')` = `NaN`, and the `NaN` spreads through `totalMs` and `remainingMs`. The session screen re-clamp does `Math.min(NaN, cap)` = `NaN`. The `Countdown` then returns `NaN`, `r <= 0` is never true, and the session has no time limit at all: a forged backup bypasses the hard cap.
- **Fix:**
  - In `validRow`, require finite positive numbers for `capMs`, `totalMs`, `remainingMs` and `perQMs`, and `kind` in `none`, `total` or `perq`, on both `sessions.timer` and `sessionDetail.timer`.
  - In `sanitizeTimer`, treat non-finite input as invalid, and fall back to the cap derived from the pack.

### Minor

**N4. Pack paper metas are not validated** (`it.fails`: "pack paper metas are not validated ...").
- On a fresh device, a pack row with `papers: [null]` restores, and `packStandardLength`/`packBudgetSec` then throw (`reading 'questionCount' of null`), which breaks the pack page.
- With a local copy present, the union code throws a raw `TypeError` mid-transaction. The restore is atomic, but the user gets an unhelpful message.
- **Fix:** validate each meta (`id`, `questionCount`, `timeLimitMin`, `present`, `keyed`), or rebuild metas from the restored papers with `metaOf`.

**N5. Question content shape is not validated** (`it.fails`: "options as a number ...").
- `options: 5` passes validation. `exportPackZip` then throws `q.options.map is not a function`, and the question screen and results page fail the same way.
- `q.id` is also not checked against `${paperId}#${n}`, so stats and sources can point at an id the paper does not use.
- **Fix:** check that `id === paperId#n`; that `options` is an array of `{text?: string, figure?: Figure}` whose length matches `optionCount` when present; that `stem`, `explanation` and `topic` are strings; that `table` has the right shape; and that `hash` is a string.

**N6. Settings numbers are type-checked but not range-checked** (`it.fails`: "1e400 restores as Infinity").
- `cleanSettings` accepts `lastBackupAtCount: Infinity`, which JSON can express as `1e400`. The backup reminder then never fires.
- **Fix:** require `Number.isFinite` and a sane range for every numeric setting.

**N7. A save refused during Save or Submit still misleads** (R6 residual).
- `saveForLater` shows "Session saved" and navigates to the pack page when the session had been submitted or discarded elsewhere.
- `finish` on a discarded session navigates to "Results not found".
- **Fix:** have `write()` return a status (`ok`, `refused` or `failed`). `saveForLater` and `finish` should branch on `refused` and show the same message and destination as the autosave path.

**N8. After a failed auto-submit, answers can still be changed at time zero.**
- With `autoFailed` set, the tick stops submitting, but `choose()` still accepts answers. A later manual Submit records the session as `submitted` rather than `auto-submitted`, so it is graded as partial if anything is unanswered. Answers given after time zero count, which breaks the hard cap.
- **Fix:** when `remaining <= 0`, lock answering and leave only Submit and Save available. When the user submits, pass `auto = true` (or retry with backoff).

**N9. The resume prompt still treats this tab's own lock as "another tab"** (R12 residual).
- **Fix:** have `sessionLockHeld` exclude a lock this tab holds. Keep a module flag set by `acquireSessionLock`, or compare `clientId` from `navigator.locks.query()`.

**N10. Sessions submitted before the key snapshot have no `detail.key`.**
- Their review still re-grades with the current key, the round-1 M5 behaviour.
- **Fix:** backfill `detail.key` once, at first open after the upgrade.

## Kept decisions (84–91)

- **84, 85, 88, 89, 90:** implemented as described, apart from the residuals noted under R6 and N7.
- **86:** only half implemented (N1, N2).
- **87:** incomplete (N3–N6).
- **91:** both kept limits are reasonable for a local self-practice tool. I would still recover stale `active` sessions per pack, skipping only the pack whose session is live; that needs the lock to carry the pack id.

## Final assessment

Everything Critical and Major from rounds 1 and 2 is fixed or explicitly kept. What remains:

- **Restore and import merges:** N1 (older backup questions dropped) and N2 (stale plan overwrites a key) can still lose data, though both need multi-device or multi-tab use.
- **Forged backups:** N3 (no time limit), N4 and N5 (broken pack screens) need a hand-edited backup.
- **Small behaviour gaps:** N6–N10.

For N1–N5, the safest single change is one shared, strict row validator, plus a single question-level `mergePaper(local, incoming)` used by both the importer and restore.
