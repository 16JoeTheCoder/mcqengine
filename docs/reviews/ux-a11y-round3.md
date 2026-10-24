# UX and accessibility review, round 3 (final)

**Build:** branch `ccr-7d4756bd-86dw39` at `ac0bc33`, built fresh and served with `vite preview` on port 4175.

**Method:** the same as rounds 1 and 2, using Playwright (Chromium) and axe-core with the WCAG 2.0, 2.1 and 2.2 A and AA rules. I tested light and dark themes, at 1280 × 720 and at 390 × 844 with touch. Decisions 57–100 in `docs/DECISIONS.md` are treated as intended.

**Result:** there are no remaining Blocker or Major findings. axe-core is clean on every screen tested: the prompt dialog, import, review, pack page, Start dialog, question screen in both themes, the Fix dialog in Exam and Practice, and results.

## Verification of round-2 items

| ID | Round 2 | Round 3 | Evidence |
| --- | --- | --- | --- |
| N1 | Major: time cap could not be cleared (75 became 175) | **Fixed** | From an empty field, typing 75 gives 75. Two Backspaces leave the field empty, not 1. Typing 5x0 gives 50. Typing 0 leaves it empty. While the cap is empty, the reason "Set a time cap for every paper." is shown. "Apply to all" copies 75 to the other paper. The imported paper card shows 75 min. |
| N2 | Major: rushed-error links went to the library | **Fixed (checked in the code)** | The links now call `preventDefault`, then scroll to the review item and focus it (`tabIndex=-1`). They no longer link to `#q-N`. I did not trigger a live rushed alert, because it needs a history of earlier sessions. |
| N3 | Prompt drafts leaked between packs and never cleared | **Fixed** | "Add papers" on the new pack opens with an empty Paper title. After a successful import, "Make a pack with AI" opens empty. Drafts are now kept per pack. |
| N4 | A failed file left its text in the import draft | **Fixed** | `wrong.zip` now gives "No JSON file found…". The textarea stays empty ("Waiting for input."), and reopening shows no stale error. |
| F4 | Review edits lost on Esc or backdrop click | **Fixed** | I set a time cap of 75, a title and a pack name, clicked the backdrop and reopened Review: all three were kept. |
| F7 | Focus lost after an import, on results and on section scrolls | **Fixed** | After an import, focus is on `h2#papers-h` ("Papers"). On results, focus is on `main#main`. The Insights section link focuses `h2#insights-h`. "Start session" and the "Full paper" card use the same `goSection`. |
| F9 | Toast leftovers | **Partly fixed** (Minor, see R1) | Identical toast texts are now merged. Different wordings of the same storage problem still stack. |
| F17 | Timer colour and the "Low" word | **Fixed** | The timer bar is the ok colour above 50%. From 50% to 10% it shades from amber to red, measured at 4:59 (143, 91, 0), 2:24 (177, 51, 38) and 0:59 (196, 30, 58). Below 10% it adds stripes, a pulse and the word "Low". On a phone the header reads "Synthetic Paper 1 / Question 1 of 8 / Low / 0:10 / End" and fits. There is no grey midpoint. |
| F23 | Import live region too noisy | **Fixed** | The status list is no longer live. A separate screen-reader-only region announces only "Valid JSON, ready to review", "N problems to fix" or "The JSON is not readable". The JSON paths are still shown in the list, which decision 100 keeps. |
| F24 | No reason given when Import is blocked | **Fixed** | A status line under Import gives the reason, such as "Name the new pack.", "Set a time cap for every paper." or "Tick the check box above to confirm." |
| F25 | Corrupt files gave raw or misleading errors | **Fixed** | A zip with no `.json` gives "No JSON file found…". A damaged zip gives "That zip could not be read…". Tampered backups are still rejected with the checksum message. |
| F26 | — | Still fixed | — |
| F27 | Charts have no data alternative | **Kept** (decision 100) | Each chart has an aria label and a sentence describing it. |
| F28 | Enter did not submit typed confirmations | **Fixed** | Typing ERASE and pressing Enter erases the data. DELETE uses the same form pattern. |
| F29 | A progress-only backup restores onto a device without the packs | **Not fixed** (Minor, see R2) | See R2 for what goes wrong. |
| F30 | Timer announcements may be lost behind modal dialogs | **Not fixed** (Minor, see R3) | The announcers are still in `.qs-head`. |
| F31 | No confirmation after a fix is saved | **Not fixed** (Minor) | The results page now explains: "A fixed answer key applies to future sessions…". The question screen still gives no "fix applied" line. |
| F32 | Backup buttons read only "Export" | **Fixed** | The buttons now read "Export progress only", "Export packs only" and "Export everything", with no `aria-label` override. |
| F33 | Random did not say questions repeat | **Fixed** | The Random card adds "Once all are seen, questions repeat." |
| F22 | Prompt-type tabs | **Fixed** | Replaced with the segmented control (a group of toggle buttons). |
| Touch | Narrow targets at 390 px | **Fixed** | After a reload with touch emulation, nothing on the pack page, Start dialog, question screen, results or settings is below 44 × 44. The section links and chips have a 44 px minimum width. "Dismiss tip" is now an icon button. Insights tabs are 44 px tall, and ← → move focus and selection. The key hints ("F", "U") are hidden on touch devices. |

## Regression pass

These all worked:

* Keyboard exam end to end with the A–D keys and ←/→.
* Enter, Enter at the last question keeps the session open, with focus on Keep going.
* Results are correct (4/4).
* The browser back button saves the session mid-way, with a toast and a notice on the pack page.
* Reload shows "Resume your session?" with focus on Resume, and resuming keeps the answers.
* A second tab shows the "open in another tab" notice, and "Submit now" there is refused with a toast.
* A mistakes drill in Exam mode hides the key in the Fix dialog.
* With storage full, Save and Submit both report the failure and keep the session open.
* The "Answered" grid fill has 18:1 contrast against unanswered cells.

## Remaining findings

There are no Blockers and no Majors.

### Minor

**R1. Storage-full messages still stack (F9 leftover).**
One failed autosave shows "Storage is full. Export a backup…" (from `app.tsx`'s `dmc:quota` listener) and also "Could not save your answers. Storage may be full…" (from `session.tsx`). A failed Submit then adds a third message, so three toasts say the same thing. The "Imported N questions." toast also carries over onto the first question of a session started within 5 s.
*Fix:* do not show the global quota toast while the session route is open, because the session screen already reports it. Alternatively, give these toasts a shared key and replace by key. Clear success toasts when navigating into a session.

**R2. A progress-only restore on a device without the packs creates a ghost session (F29).**
I restored `dmc-progress-*.json` onto an empty device. The dialog says "Adds 3 sessions, 5 question stats" and gives no warning. A saved drill from that backup then shows "Resume your session?" on every app open. Resuming it runs a timer over "This question could not be loaded."
*Fix:* in `RestoreDialog` and `planRestore` (`data.tsx` and `backup.ts`), warn when the backup refers to packs that are not on this device. Skip or close open sessions whose pack is missing. The resume prompt in `app.tsx` should also ignore sessions whose pack does not exist.

**R3. Timer announcements sit behind open dialogs (F30, unchanged, not checked with a real screen reader).**
While End session or Fix is open (`aria-modal`), the live regions in `.qs-head` are outside the dialog, so VoiceOver may not read a 1-minute warning.
*Fix:* render both announcers in a container at the end of `body`.

**R4. The pack notice in a second tab still offers actions that will be refused.**
While tab 1 runs the session, tab 2's pack page shows "Saved session: … | Discard | Submit now | Resume" as if they work. Each button only produces the "running in another tab" toast.
*Fix (`pack.tsx`):* when `sessionLockHeld()`, show "Open in another tab" and disable Discard and Submit now. It could be checked on render and on the BroadcastChannel ping.

**R5. Next uses the same inverse fill as a selected answer and an answered grid cell.**
On the question screen, the solid black Next button (white in dark theme) reads like a selected option. The grid legend says "Answered: filled" in that same fill. This is not a WCAG failure, just a small visual ambiguity next to decision 76.
*Fix:* keep Next as a default outlined button, or give it a distinct arrow-led style.

**R6. Small copy and input details.**
* Typing 900 in a time cap is silently capped to 600, with no message. Consider "Capped at 600 min".
* The question-screen fix still gives no "Your fix is applied" line (F31).

## Kept by decision (not reported)

The ↑/↓ roving focus moves without selecting, and ←/→ navigate questions (decision 72). Charts have no data tables (decision 100). Import errors keep their JSON paths in the visible list (decision 100). The timer bar drains from the left (decision 74).

## Method notes

Scripts are in `/tmp/claude-0/-home-user-mcqengine/701b595c-11bd-5b61-bab0-60ab67bedf0d/scratchpad/ux/r3/` and screenshots in `ux/shots3/`. Storage-full behaviour was simulated by making IndexedDB writes throw `QuotaExceededError`. Touch-target sizes were measured after a full reload. Measurements taken after hash-only navigation in an emulated mobile context under-report the coarse-pointer sizes, so they were discarded.
