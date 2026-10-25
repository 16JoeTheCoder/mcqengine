# Logic and data-integrity review, round 2

Branch `ccr-7d4756bd-86dw39` at `da7fc0a`. I re-checked every round-1 finding against the new code and attacked the new code paths for regressions:

- `backup.ts`: `planRestore` and `applyRestore`
- `db.ts`: `persistOpenSession`
- `session.ts`: `createSession` and the time cap in `submitSession`
- `session.tsx`: `persist`, `finish`, `saveForLater` and lock release
- `app.tsx`: `recoverSessions`
- `importer.ts`: the transaction in `commitImport`

No source files were changed.

**New test file:** `tests/unit/audit-round2.test.ts` (12 tests). 10 of them are `it.fails` and demonstrate real bugs. I ran each `it.fails` as a plain `it`, and every one failed on its intended assertion. The suite is green at 170 tests, and `tsc` and `eslint` are clean.

Cosmetic: several converted round-1 tests are titled "fixed: <description of the bug>", for example "fixed: the engine allows a second open session...". They now assert the corrected behaviour, so the titles read backwards. Separately, "auto-submit with nothing answered: complete, ..." now asserts `partial: true`. Please retitle them.

---

## Status of round-1 findings

| # | Round-1 finding | Status | Notes |
| --- | --- | --- | --- |
| C1 | Stale write after submit, double grading | **Fixed (core)** | `persistOpenSession` refuses writes inside the transaction, recovery is skipped while the lock is held, and the pack page and resume prompt check the lock. Remaining gaps: R2 (lock released too early), R6 (dead-end screen), R7 (Delete pack does not check the lock). |
| M1 | Closing the tab pauses the clock | **Not fixed (kept, D31)** | The heartbeat is now 2 s, so up to 2 s can still come back on each refresh. The comment above `recoverSessions` still says "remaining time therefore never increases", which is not strictly true. The reasoning is acceptable for self-practice, but it remains a deviation from the spec's hard cap. |
| M2 | Auto-submit complete; zero-answer counted as done | **Partly (kept, D34)** | Zero-answer auto-submits are now partial and excluded everywhere (tested). Auto-submits with some answers stay complete; that is a reasoned product decision. |
| M3 | One open session per pack not enforced in the engine | **Partly** | Now enforced in `createSession`, but the check is outside the write transaction, so two concurrent starts both succeed (R1). |
| M4 | Stale writes bring back deleted sessions | **Fixed** | The running tab is left with dead buttons (R6). |
| M5 | Key fix after a session makes results disagree | **Partly** | The key snapshot (`detail.key`) keeps each review consistent with its stored score. Three gaps remain (R8): the mistakes bank keeps misses that were caused by the wrong key; the exam-mode Fix dialog tells the user to fix the key "from the results page after you submit", but the results page has no Fix control; sessions submitted before this change have no snapshot and still re-grade with the current key. |
| M6 | Restore does no schema validation | **Partly** | Tier, checksum, image hashes, timer clamping and open-session limits are handled. The row checks are shallow (R4). |
| M7 | Restored same-id pack orphans papers | **Partly** | Paper lists are now unioned and new pack ids get a random suffix. But when the incoming pack row is newer, its papers overwrite more complete local papers and questions are lost (R3). The suffix collision check is also ineffective (R5b). |
| m1 | Countdown misses some backward clock jumps | **Fixed** | Detection is now relative to the monotonic clock. The randomised clock properties from round 1 still pass. |
| m2 | `sanitizeTimer` accepts a negative per-question budget | **Partly** | It is now floored at 1 ms rather than at a whole second (R9). |
| m3 | Downgraded verdict says "within noise" | **Fixed** | Now labelled "Mixed signals, possibly ...". |
| m4 | Verdict windows differ from the spec | **Accepted (D66)** | The spec should be updated. |
| m5 | Detrended noise, inconsistent trend band | **Partly** | The band now uses the residual SD, but without the verdict's half-question floor, so a steady series draws a zero-width band (R10). |
| m6 | Later chunk grows a paper past its count | **Fixed** | Now reported as a conflict. |
| m7 | Concurrent imports drop a paper from the pack list | **Partly** | The pack list update is now transactional, but the lost update still happens at paper level (R5a). |
| m8 | Strict per-question mode in a hidden tab | **Accepted (D66)** | |
| m9 | Screen stuck if submit throws | **Fixed** | A failing auto-submit now retries every 250 ms (R11). |
| m10–m12 | Include-partial option, KPI filters, untimed practice | **Accepted (D66)** | |

---

## New findings

### Major

#### R1. Two concurrent starts can still create two open sessions in one pack (D58)
- **Test:** `audit-round2.test.ts` "BUG: the check in createSession is outside the write transaction..."; both `createSession` calls succeed.
- **Cause:** `createSession` calls `getOpenSessions()` first, then awaits content loading, stats and locks, and only then calls `saveSessionState`. Two starts (two tabs, or a resume-prompt race) both pass the check.
- **Fix:** move the check into the transaction that writes the new session. Read the `status` index for `active` and `saved` filtered by `packId` inside a `readwrite` transaction on `sessions` and `sessionDetail`, and abort if one exists. The read and the write must be in the same transaction.

#### R2. The session lock is released before the final save on unmount (D57)
- **Test:** "BUG: Preact runs the parent SessionScreen cleanup before the child Runner cleanup...". It uses the real `finalWrite` and `setFinalWrite` with the same component nesting as `session.tsx`. The release happens before the write completes (released at step 1, write done at step 2).
- **Cause:** Preact's `unmount()` runs the parent's hook cleanups (`options.unmount`) before it unmounts the children. `SessionScreen`'s cleanup therefore captures `finalWrite` before `Runner`'s cleanup calls `persist('saved', true)`, which is what replaces `finalWrite`.
- **Effect:** on back-button or route change, the lock goes free while the final save is still pending. Another tab can open the session, load data without the last answers, and then have those answers overwritten.
- **Fix:** release the lock from the Runner side. For example, pass `release` into `Runner` and call it in `persist(...,true).finally(release)` inside the unmount cleanup. Alternatively, have `SessionScreen`'s cleanup defer with `queueMicrotask(() => finalWrite.then(rel))` so the child's cleanup has already queued its write.

#### R3. A newer pack row from a backup overwrites a more complete local paper, and questions are lost (D54, D60)
- **Test:** "BUG: a newer pack row from a backup overwrites a more complete local paper..."; `p1` goes from 4 questions back to 2.
- **Steps:**
  1. Devices A and B share a pack (B restored A's backup).
  2. B imports chunk 2 of paper `p1`.
  3. A uses Fix on any question. `refreshPackMeta` in `fix.tsx` bumps `pack.updatedAt`.
  4. A makes a backup, and B restores it.
  5. In `applyRestore`, the incoming pack is newer, so it wins; `papers` then takes every incoming paper (`winners.has('pack:…')`). B's chunk 2 is gone, and B's stats, sessions and overrides for `p1#3` and `p1#4` now point at questions that no longer exist.
- **Fix:** merge papers at question level. Take the union of questions by `n`; when the same question differs, prefer the newer copy, or report a conflict. Then recompute the meta with `metaOf`. Never replace a paper wholesale.

#### R4. Restore row validation is shallow (D60: "rejects the whole backup if any row fails shape checks")
Three tests (all `it.fails`) show rows that pass the checks with a recomputed checksum:
- **Paper with null questions:** a paper whose `questions` array contains `null` is restored, and `loadPackContent` then throws `TypeError: Cannot read properties of null (reading 'id')`. The pack page, session start and Random are broken until the pack is deleted.
- **Settings of the wrong type:** for example `{ backupEvery: 'never', theme: 42, dismissedTips: 'x' }` is accepted. `getSettings` spreads it over the defaults, so later code does arithmetic on a string (`completed - lastBackupAtCount >= backupEvery`) and calls `includes` on a non-array.
- **Mismatched stat key:** a `questionStats` row whose `key` does not equal `${packId}::${qid}` is accepted. It duplicates the real stat for that question, and `getStats` returns both.

Also unchecked: `sessionDetail.answers` entries (choice range, record shape), `detail.key` length, that every `sessionDetail` has a matching `sessions` row, and question objects inside papers.

**Fix:** validate nested shapes:
- each question: `id === paperId#n`, integer `n`, `optionCount` 2–5, `answer` null or in range, string `hash`;
- each answer record: `qid` in `questionIds`, `choice` null or in range;
- settings: per-field type and range checks, or rebuild from `DEFAULT_SETTINGS` keeping only well-typed fields;
- stat key equals `${packId}::${qid}`; bank events reference that pack.

### Minor

#### R5a. Two import plans for chunks of the same paper drop the first chunk
- **Test:** "BUG: two plans for chunks of the same paper...".
- **Cause:** each plan merges against the paper as it was stored at planning time. `commitImport` writes the planned `Paper` wholesale, so the second commit erases the first chunk. This needs two import wizards open at once, in two tabs.
- **Fix:** re-run `mergeDoc` against the current papers inside the commit transaction, or store a version on each paper and refuse a stale plan.

#### R5b. The pack-id collision check is ineffective (D61)
- **Test:** with randomness forced, two imports with the same title get the same id, and the second overwrites the first pack.
- **Cause:** `commitImport` checks `packs.get(base)`, but the bare slug is never used as an id any more, so the 5-character branch never runs. The suffix comes from 2 random bytes, which gives 65,536 values per title. A collision overwrites the pack row: its paper list is lost and its papers are orphaned.
- **Fix:** loop until `packs.get(candidate)` is empty, inside the same transaction, and use a longer suffix.

#### R6. A refused autosave leaves the session screen silently dead
- **Where:** `session.tsx` `write()`. When `persistOpenSession` returns false, the code sets `ended.current = true` and shows nothing.
- **Effect:** `finish()` and `saveForLater()` both return at once, because of the `if (ended.current) return` guard. Submit and Save do nothing, and later answers are dropped without notice. If the refusal happens inside `saveForLater`'s own write, `lastOk` stays true, so the user is told "Session saved" when the session had already been discarded or submitted elsewhere.
- **Fix:** have `write()` return the refusal. On refusal, show "This session was finished or discarded in another tab" and navigate to its results, or to the pack page.

#### R7. Delete pack does not check the session lock
- **Where:** `pack.tsx` `del()`. The resume prompt and the saved-session banner now check `sessionLockHeld()`; Delete pack does not.
- **Effect:** deleting a pack from tab B while tab A runs a session in it leads to R6 in tab A.
- **Fix:** apply the same guard as the other two actions.

#### R8. The key-fix flow after an exam is incomplete (M5 follow-up)
- **Advertised path does not exist:** the exam-mode Fix dialog says "fix the key from the results page after you submit". `results.tsx` has no Fix control. The only other entry point is the pack page's Data section, and that lists only questions that were *reported*.
- **Bank keeps false misses:** questions marked wrong under the old key stay in the mistakes bank, and their `missed` count still includes the false miss.
- **Legacy sessions:** sessions submitted before this change have no `key` snapshot and still re-grade with the current key.
- **Fix:**
  - Add Fix to the results review.
  - When a key changes, offer to rebuild that pack's stats by replaying the stored details with the corrected key.
  - At first open after upgrade, backfill `detail.key` for legacy sessions from the current key.

#### R9. `sanitizeTimer` floors the per-question budget at 1 ms
- **Test:** "BUG (minor): sanitizeTimer floors ... at 1 ms".
- **Effect:** a negative or tampered `perQMs` now gives a 1 ms per question budget and therefore an immediate auto-submit. The spec's per-question budget is in whole seconds.
- **Fix:** `max(1000, floor(min(perQMs, capMs/q)/1000)*1000)`.

#### R10. The trend band collapses to zero width for a steady series
- **Test:** "BUG (minor): the trend band collapses to zero width...".
- **Cause:** decision 65 aligned the band with the verdict's residual SD but not with the verdict's floor of `0.5/N`.
- **Fix:** apply the same floor.

#### R11. A failing auto-submit retries every 250 ms
- **Where:** `finish(true)` resets `ended` on error, and the next tick sees `r <= 0` and calls `finish(true)` again.
- **Effect:** under a full disk, this runs an IndexedDB transaction and posts a "Could not submit" toast four times a second.
- **Fix:** after a failed auto-submit, stop the tick (or back off), and show one persistent notice with a "Try again" button.

#### R12. Smaller gaps
- **Same-tab lock blocks the resume prompt:** `sessionLockHeld()` is true for this tab's own lock. After a refresh on the session screen, the resume prompt for *other packs'* saved sessions refuses Submit and Discard with "running in another tab".
- **Stale active sessions not offered for resume:** while any tab holds the lock, recovery is skipped entirely. Stale `active` sessions in *other* packs stay `active`, and the resume prompt does not offer them, because it lists only `saved` ones.
- **Cap can shrink on resume:** `SessionScreen` re-derives the random and drill cap from the pack's *current* papers. Importing papers with shorter time budgets between Save and Resume shrinks a saved session's remaining time. It never grows, so this is within the spec, but it is surprising.
- **Fix:** have `sessionLockHeld` ignore a lock this tab holds; recover stale actives per pack; store the creation-time cap on the session and clamp to `min(storedCap, derivedCap)` only for paper sessions.

---

## Checked and holding

- **Stale writes are refused:** `persistOpenSession` refuses inside the transaction when the session is missing or finished, so there is no un-submit, double grading or resurrection.
- **Earlier properties still hold:** the round-1 randomised lifecycle (25 sequences), concurrent submits, the Countdown properties and the timer clamp properties all pass unchanged.
- **Zero-answer auto-submit:** partial, not a paper done, not counted in sessions done, and kept out of the trend even with "Include partial" on (new test).
- **Time cap at submit:** `submitSession` caps recorded time at the session budget (new test).
- **Restore safety checks:** whole-backup rejection on a missing key, tier-limited stores, image bytes checked against their SHA-256 ids, clamped timers, and one open session per pack on restore all work as described (converted round-1 tests).
- **Restore round-trip:** everything export → wipe → import is still identical and idempotent.
- **Verdict label** after a slope downgrade and the chunk-count conflict behave as decided.
