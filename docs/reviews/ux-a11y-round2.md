# UX and accessibility review, round 2

Build under test: branch `ccr-7d4756bd-86dw39` at `da7fc0a`, built fresh and served with `vite preview` on port 4175. Tested with Playwright (Chromium) and axe-core (WCAG 2.0/2.1/2.2 A and AA), in light and dark themes, at 1280 × 720 and at 390 × 844 with touch. The method matches round 1 (`ux-a11y-round1.md`). Decisions 57 to 83 in `docs/DECISIONS.md` are taken as intended behaviour.

axe-core is clean on every screen tested: first run, prompt dialog, import, review, pack page, Start dialog, question screen (exam and practice, both themes), Fix dialog (exam and practice) and results. The round-1 rule failures (paper-card name, `aria-pressed` on radios) are gone.

## Summary

| | Round 1 | Fixed | Partly fixed | Not fixed |
| --- | --- | --- | --- | --- |
| Blocker | 1 | 1 | 0 | 0 |
| Major | 12 | 9 | 3 (F4, F7, F9) | 0 |
| Minor | 21 | 7 | 4 (F13, F17, F18, F25) | 10 (F29 not re-tested in the UI) |

New in round 2: 2 Major (N1, N2) and 4 Minor (N3 to N6). N1 and N2 already existed in round 1; I missed them then.

## Round-1 findings, re-tested

### Blocker and Major

| ID | Finding | Status | Evidence (round 2) |
| --- | --- | --- | --- |
| F1b | Second tab double-grades a running session | **Fixed** | Tab 2 no longer shows the resume prompt. "Submit now" and "Discard" on tab 2's pack page show "A session is running in another tab. Finish it there first." After tab 1 submits: one session, `timesSeen` 1 for each question. Closing the tab mid-session leaves it `active`, and the next open offers Resume (decision 31). |
| F1 | Enter, Enter submits | **Fixed** | Enter on the last question opens End session with focus on "Keep going". The second Enter closes the dialog and the session continues. |
| F2 | Fix dialog shows and edits the key in an Exam | **Fixed** | In an Exam there is no "Correct answer" control, only "The answer key is hidden during an Exam…". In Practice, after checking, the key control is shown (correct by design). |
| F3 | Storage full: false "Session saved"; Submit locks up | **Fixed** (one Minor left, see F3-m) | Save shows "Could not save the session: storage is full…" and stays on the session. A failed Submit re-enables the buttons and the clock keeps running (9:53). Once space is freed, Save works and reload shows 2 of 4 answered. |
| F4 | Esc, backdrop or Cancel discards import and prompt work | **Partly fixed** | Pasted JSON (671 characters) and the prompt fields survive Esc. Review-step edits are still lost: after a time cap of 10 and an edited title, a backdrop click closes the wizard, and reopening Review shows the time cap empty and the title reset. Fix: in `import.tsx`, keep `ov`, `targetId` and the new-pack name and subject in the module `draft` too, keyed by paper id. Alternatively, make the `size="full"` Review modal non-dismissable from the backdrop. |
| F5 | Blocked Start dialog leaves focus behind the modal | **Fixed** | Focus lands on Cancel inside the modal. "Resume saved session" opens the saved session at the question where it was left. |
| F6 | Skip link invisible and inert | **Fixed** | 145 × 40 px with an inverse background when focused. Enter moves focus to `main#main`. |
| F7 | Focus and announcements lost on changes | **Partly fixed** | Fixed: session start focuses `main#main`. ← and → announce "Question 2 of 4" in an atomic polite region. Strict auto-advance announces "Question 3 of 8". Save → pack page focuses main. Still broken: (a) after an import, focus is on `<body>`, because the route has `?s=papers` and the effect in `app.tsx` returns before focusing. (b) On results, focus is on `<body>`: results load lazily, so at the next animation frame only the skeleton `<main>` is present, and it has no `id`. (c) "Start session", the "Full paper" card and the section links (Overview, Start, Papers…) still only scroll; the next Tab goes to "Score" or "Insights". Fix: (a) focus the section heading after `scrollIntoView` in `pack.tsx`, which also fixes (c). (b) Give the loading `<main>` in `results.tsx` and `pack.tsx` `id="main" tabIndex={-1}`, or focus after the data loads. |
| F8 | Paper cards hide their status | **Fixed** | No `aria-label`. The name is the visible text: "Synthetic Paper 1 — 4 Q 6 min 0 attempts" plus badges. |
| F9 | Toasts cover controls, vanish, pile up, invisible focus | **Mostly fixed** | On the question screen toasts sit at the top (y = 68 to 116 px, Next at 358 px). The queue is capped at 3. The focus ring is on-inverse (17:1). Errors stay 10 to 12 s. Left over: see F9-m. |
| F10 | Answered and unanswered look the same | **Fixed** | Answered cells use the inverse fill: 18.5:1 (light) and 15.9:1 (dark) against unanswered. The number on an answered cell is 17:1. The current cell has an offset ring. |
| F11 | Maths read ambiguously | **Fixed** (check N6) | Fractions are labelled "v over λ" and roots "square root of …". Table options get sr-only column names. |
| F12 | First visit reloads the page | **Fixed** | One navigation only (at 12 ms). The service worker controls the page with no reload. |

### Minor

| ID | Finding | Status | Note |
| --- | --- | --- | --- |
| F13 | Radio-group keys | **Partly fixed (by decision 72)** | ↑ and ↓ move focus with wrap-around (A ↑↑ → D). Space or Enter chooses. Only one option is in the Tab order (roving). ← and → stay on question navigation. Arrows move focus but do not check the option. That differs from the ARIA radio pattern, but it is documented in decision 72 and the keyboard hint. Consider `aria-keyshortcuts`, or an sr-only hint on the group ("Up and Down to move, Space to choose"). |
| F14 | `role="radio"` with `aria-pressed` in the Fix dialog | **Fixed** | axe clean. |
| F15 | Strict mode "Q 0:00" flash | **Fixed or not observed** | In real time with 3 s per question: Q1 shows 0:03 → 0:01, then Q2 0:03, with no 0:00 flash and no skipped question. |
| F16 | "No limit" is not unlimited | **Fixed** | Now "Full time (10 min)". |
| F17 | Timer hue drift and colour-blind confusion | **Partly fixed** | sRGB mixing removes the magenta and green. Two things remain. At 75% the bar is a desaturated grey: (77, 93, 91) in light and (175, 180, 148) in dark, which reads as "inactive". Simulated deuteranopia, light theme: 50% against 25% is now ΔE 6.0 (was 2.4), still hard to tell apart. The "Low" word at 10% is `hide-sm`, so phones get stripes and pulse only. Fix: step through solid colours (ok > 50%, warn 50 to 10%, bad < 10%), or mix through a brighter midpoint. Show "Low" on phones too, for example by colouring the clock and adding a word next to it. |
| F18 | Touch targets under 44 px | **Mostly fixed** | Measured after a reload at 390 px with touch: small buttons, chips and segmented buttons are 44 px tall, and "Fix this question" is 157 × 44. Still narrow: the section links "Data" (31 × 48) and "Start" (35 × 48), the "All" chip (41 × 44) and "Dismiss tip" (42 × 44). Fix: `min-width: var(--hit-min)` on `.secnav a`, `.chip` and icon buttons. |
| F19 | Mobile question-screen layout | **Fixed**, one item left | Two-column grid: Flag and Unsure, then Previous and Next (Next on the right). The header shortens to "End" (`aria-label` "End session"). The keyboard hints "F" and "U" still show on touch devices: hide `.kbd` under `(hover: none)`. |
| F20 | Minutes field shows unclamped values | **Fixed** | 99 shows as 10 after blur. |
| F21 | "Copied" goes stale | **Fixed** | Resets after 2.5 s. During those 2.5 s it can still say "Copied" after an edit; resetting it on `prompt` change would be exact. |
| F22 | Prompt dialog tabs | **Not fixed** | Unchanged in `prompt.tsx` (no `tabpanel`, no `aria-controls`, no arrow keys). Only shown for an existing pack. |
| F23 | Noisy import live region, machine paths | **Not fixed** | `#import-status` still holds the full error list (2,448 characters for 40 errors) and is re-read on every debounce. Errors still read "papers[0].questions[2].options…". |
| F24 | Blocked Import gives no reason | **Not fixed** | With "Pack name" empty, Import is disabled and nothing explains why. The time-cap message is still not linked through `aria-describedby`. |
| F25 | Corrupt files give raw errors | **Partly fixed** | A damaged zip now says "That zip could not be read. Is it a DMC pack or backup zip?". A zip with only `readme.txt` is still parsed as the pack ("Unexpected 'h'"). See also N4. |
| F26 | Results time exceeds the budget | **Fixed** | A 5:00 exam with a +400 s clock jump records "5:00 time". |
| F27 | Charts are images only | **Not fixed** | Still `role="img"` with a title, and no data alternative. |
| F28 | Enter does not submit typed confirmations | **Not fixed** | Typing ERASE then Enter does nothing. |
| F29 | Progress-only restore without packs | **Not re-tested in the UI** | No change to `data.tsx` warnings. Decision 60 adds shape checks, but there is still no "these stats belong to packs not on this device" warning. |
| F30 | Timer announcer behind aria-modal dialogs | **Not fixed** | The announcers are still in `.qs-head`, outside any open End session or Fix dialog. Not verified with a real screen reader. |
| F31 | No confirmation after a fix is saved | **Not fixed** | |
| F32 | Backup buttons say "Export" | **Not fixed** | `aria-label` "Export everything" over visible "Export". The busy text is still hidden from assistive technology. |
| F33 | Random says nothing about repeats | **Not fixed** | The card still reads "6 questions from across the pack, least-seen first". |

## New findings

### N1. Clearing the time-cap or question-count field in Review makes it 1, and typing turns 75 into 175 (Major)
Steps: import JSON without `timeLimitMinutes`, choose Review import, click in "Time cap (min)", select all and press Backspace, then type `75`.

What happened: the field can never be empty. `Math.max(1, Math.min(600, Number(v) || 0)) || undefined` turns `''` into `1`. Backspace leaves "1", so typing 75 gives **175**, and typing 10 from empty gives **110**. Typing `5x` gives 1. The question-count field uses the same pattern. The time cap is the hard maximum for every timer (decision 27), so a student can lock a paper at 175 or 110 minutes without noticing. The paper card is the only place the cap shows.

This bug was already present in round 1 (`import.tsx`, review table inputs); I missed it then.

Fix (`src/screens/import.tsx`): store the raw text per field. Parse on blur, or keep `''` as `undefined` (`v.trim() === '' ? undefined : clamp(Number(v))`). Show an inline error for values outside 1 to 600, and show the parsed value next to the field ("= 1 h 15 min"), so a 175 is obvious.

### N2. The links in the rushed-error list leave the results page (Major)
`results.tsx` renders rushed errors as `<a href="#q-3">`. The app uses hash routing, so `parseRoute('#q-3')` returns the library. A test anchor to `#q-0` on a results page went to `#q-0`, with the library ("Your packs") on screen. The student loses the results they were reading, and the link never scrolls to the question. This was also present in round 1 (as chips).

Fix: use buttons that call `document.getElementById('q-3')?.scrollIntoView()` and focus that review item (`tabIndex=-1`). Alternatively, encode the anchor in the route (`#/results/id?q=3`) and scroll to it on render.

### N3. Prompt drafts never clear and leak between packs (Minor)
Decision 70 says drafts last until an import succeeds, but `prompt.tsx` `drafts` is never cleared. After importing, "Add papers" on any pack opens with the previous "Paper title" ("May/June 2025 Paper 13"), and the paper id defaults to its slug. A student who copies the prompt without changing the title gets the same paper id, so the next import merges into, or conflicts with, the old paper. The `packTitle`, `paperTitle` and `paperId` keys are global, not per pack.

Fix: clear `drafts` (except per-pack `subject`) when an import commits. Key paper-level drafts by pack id.

### N4. The import draft brings back stale errors after a failed file (Minor)
When a file load fails (for example the zip with `readme.txt`), its text stays in the draft. The next time Import opens, the textarea holds that text and shows "Not readable: Unexpected 'h'" before the user does anything. Choosing a second, unreadable file then shows both a toast and the old file's error.

Fix (`import.tsx` `load`): write the draft only from text the user typed, or clear the draft and `source` when a load fails. Add a "Clear" button next to the textarea.

### N5. Toast left-overs (Minor)
* Duplicates: when an autosave fails, "Storage is full. Export a backup…" (from `dmc:quota` in `app.tsx`) and "Could not save your answers…" (from `session.tsx`) both appear, and the first repeats. In the round-2 run, two of the three visible toasts were the same text.
* Toasts carry over between pages: "Imported 8 questions." appears on top of the first question of a just-started session, covering the question card's top edge.
* After a failed Submit, "Your answers are safe" is not accurate while storage is full; they exist only in memory until a save succeeds.

Fix (`app-state.ts` `toast`): skip a toast whose text matches one already visible. Clear non-error toasts on navigation to the session. Make the `dmc:quota` toast and the session's message one message. Say "Your answers are kept on this screen. Free some space, then save."

### N6. Edge cases in the question announcement and table columns (Minor)
* ← then → within one render (Q2 → Q1 → Q2) leaves the atomic region text at "Question 2 of 4". The DOM does not change, so nothing is announced. Fix: append a counter or a zero-width toggle, or clear the region before setting it.
* Table-option column names are inserted raw (`q.table.columns[k]`), so a header written in markup (for example `m s^{-1}`) would be read with its LaTeX. Fix: pass the header through the same `speak()` used for fractions.

## Other checks

* Timer announcements: with a 10-minute timer, the region says "Half…" at 5:00, "A quarter…" at 2:30 and "One minute remains." at 1:00. At 1:00 the 10% mark coincides with one minute, so a single message is correct. There is no per-second chatter. The "Low" badge appears at 10% on desktop.
* Contrast in both themes passes: grid cells (above); the practice wrong-answer border is 5.6:1 (light) and 6.5:1 (dark) against the raised surface, with the option text reverting to ink; the timer fill against the track is 4.6 to 10.7:1; focus rings on toasts are 17:1.
* Strict per-question mode in real time: one question per 3 s, nothing skipped. Fake-clock runs (`page.clock.runFor`) still jump two questions per expiry, which comes from the test clock firing timers without rendering in between (decision 66 notes the hidden-tab limit). It is not counted as a defect.
* Offline and backups were not changed in ways that affect UX. Tampered backups are still rejected ("Checksum mismatch…").

## Method notes

Scripts are in the session scratchpad (`/tmp/claude-0/-home-user-mcqengine/701b595c-11bd-5b61-bab0-60ab67bedf0d/scratchpad/ux/r2/`), and screenshots are in `ux/shots2/`. Storage-full behaviour was simulated by making `IDBObjectStore.put` and `add` throw `QuotaExceededError` on demand. Touch-target sizes were measured after a page reload under `isMobile` and `hasTouch`. Measurements taken during modal animations under-report heights and were discarded.
