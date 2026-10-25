# UX and accessibility review, round 1

Scope: the running production build (`npm run build` and `vite preview` on port 4175), tested with Playwright (Chromium) and axe-core (WCAG 2.0/2.1/2.2 A and AA tags), in light and dark themes, at 1280 × 720 and at 390 × 844 with touch. Deliberate decisions in `docs/DECISIONS.md` are not reported as defects unless they cause a problem the decision did not foresee.

Build under test: commit `b522d26`, built 2026-10-24 16:28 UTC. While this review ran, someone else was editing the working tree (uncommitted changes to `app.tsx`, `session.tsx`, `tablock.ts`, `db.ts`, `session.ts`, `pack.tsx`, `import.tsx` and others). Where those edits look aimed at a finding, it is marked **WIP fix seen, not verified**. Line numbers refer to `b522d26`.

Severity: **Blocker** = silent data corruption or a core task that cannot be done. **Major** = a WCAG AA failure on a core path, data loss, or a real risk of a wrong result. **Minor** = friction, polish, or a failure off the main path.

axe-core reported no issues on the first-run screen, prompt dialog, import dialog, review, settings, results, the question screen in both themes, or the restore dialog. It found two rule failures (F8, F27). Most of the findings below come from manual and scripted testing that axe cannot do.

## Journey step counts

Counts are clicks or keypresses with a mouse or touch, plus the choices the user must make. "Keyboard" is the number of keypresses with no mouse, starting from the top of the page.

| Journey | Steps (pointer) | Decisions | Keyboard | Notes |
| --- | --- | --- | --- | --- |
| First run to first action | 1 | 1 (AI or file) | 7 Tabs to reach "Make a pack with AI" | Skip link is focused first but does nothing (F6) |
| Make a pack with AI (prompt only) | 4: open, pack name, paper title, Copy | 2 required fields, 9 optional controls on one screen | about 5, plus Tab through 14 controls to reach Copy | "Copied" never resets (F21) |
| AI reply to imported pack (paste) | 4: Import, paste, Review, Import (+1 if time cap missing) | 1 to 2 | 5 to 7 | |
| Import from file / zip | 5: Import, Choose file, OS picker, Review, Import | 1 | 6+ | |
| Import by drag and drop | 3: drop, Review, Import | 1 | n/a | Works on any page; targets the open pack |
| Fix a validation error | 8: Copy fix prompt, switch to the AI chat, paste, copy the reply, switch back, select all, paste, Review, Import | 0 | 1 Tab from textarea to "Copy fix prompt" | Errors are shown as JSON paths (F23) |
| Start an exam (library to question 1) | 3: pack card, paper card, Start | 2 (mode, timer; defaults are Exam and "No limit") | 11 Tabs + Enter + Enter on pack page | "Start session" button only scrolls (F7) |
| Exam with a fixed total | 5: + Fixed total, + minutes | 3 | +4 | Typed value not clamped on screen (F20) |
| Timer expiry | 0 | 0 | 0 | Auto-submits, toast, results. Announcements correct (see note in F7) |
| End by Submit | 2: End session, Submit | 1 | **2: Enter, Enter at the last question** | Too easy to submit by accident (F1) |
| End by Save for later | 2 | 1 | 3 to 4 | |
| Resume after reload | 0 (on the session screen) / 1 (cold open: Resume) | 0 to 1 | 1 (Resume is autofocused) | |
| Random set (partly used pool) | 2: Random card, Start | 1 | about 13 | Card does not say how many questions are repeats (F33) |
| Mistakes drill | 2: Drill card, Start | 1 | about 14 | |
| Export everything | 2: Settings, Export everything (+ browser save) | 0 | about 12 | |
| Erase everything | 3: Erase, type ERASE, confirm | 1 | 4 (Enter in the field does nothing, F28) | |
| Restore on a second device | 4: Import, Choose file, picker, Import backup | 0 | 6+ | Checksum and tamper checks work |
| Offline after first load | 0 | 0 | 0 | Reload, start, submit, results and settings all work offline |

## Findings

### Blocker

#### F1b. A second tab invites the user to submit a session that is still running, and its answers are graded twice
*Blocker. WIP fix seen in `app.tsx`, `pack.tsx`, `tablock.ts`, `db.ts` and `session.tsx`, not verified.*

Steps:
1. Tab 1: start an exam paper and answer question 1 wrongly.
2. Tab 2: open DMC at the library or pack page.
3. Tab 2 shows "Resume your session?" for the session running in tab 1 (`recoverSessions` has already marked it `saved`). Choose **Submit now**, or **Submit now** on the pack page notice.
4. Tab 1: answer question 2, then End session and Submit.

What happened: the session is submitted twice. The question stats show `p1#1 timesSeen: 2`. Tab 1's autosave first sets the submitted session back to `active` (`submitted` → `active` → `submitted`), and the mistakes bank and trend count it again. Tab 2's results page is stale. Discard in tab 2 deletes the row while tab 1 keeps writing to it.

Expected: tab 2 never offers resume, submit or discard for a session that holds the lock. A submitted or deleted session can never be written to again.

Fix: in `app.tsx` `recoverSessions` and the resume prompt, skip all of this while `navigator.locks.query()` shows `dmc-active-session` held. In `pack.tsx` `resolveSaved`, disable the notice's buttons and label it "Open in another tab". In `db.saveSessionState`, refuse inside the transaction when the stored status is `submitted` or `auto-submitted`, or the row is gone. In `submitSession`, refuse when `pre.status === 'active'` and the lock is held elsewhere. The WIP diff adds `sessionLockHeld()` and `persistOpenSession()`, which is the right shape. Add an e2e test with two pages.

### Major

#### F1. Two Enter presses submit the paper, partial answers included
Steps: start an exam and answer one question. Press → until the last question, then press Enter twice.

What happened: the first Enter opens End session (`session.tsx` keyboard handler: Enter on the last question calls `setEndOpen(true)`). The dialog autofocuses **Submit**, so the second Enter submits. With 1 of 4 answered, it submits a partial paper.

Expected: an irreversible action needs a deliberate choice.

Fix: in `session.tsx`, put `autoFocus` on **Keep going**, or on the dialog itself, instead of Submit. Do not let Enter on the last question open the dialog; only → or Finish should. Optionally, ignore Enter on Submit for 300 ms after the dialog opens.

#### F2. "Fix this question" shows and edits the answer key in the middle of an exam
Steps: start an exam paper, choose A, select **Fix this question**.

What happened: the "Correct answer" control appears with the key (B) selected. Changing it to A and saving, then submitting, scores the question correct (1/4, 100% accuracy on 1 answered). Fixing is one click from every question.

Expected: in Exam mode, the editor hides the key until the session ends, or offers only "Report a problem" and a note. Key edits made during a session do not apply to that session.

Fix: in `src/screens/fix.tsx`, add a prop `hideKey` that `session.tsx` passes as `exam && !a.checked`. With it, render the answer seg as "Hidden until you submit", and keep text, figure and report editing. The WIP `key` snapshot taken at submit time does not stop this, because the override is saved before submitting.

#### F3. With storage full, "Save for later" says it saved when it did not, and Submit locks up
*Submit part: WIP fix seen in `session.tsx` `finish`, not verified.*

Steps: stub `IDBObjectStore.put` to throw `QuotaExceededError`, answer a question, then End session → **Save for later**.

What happened: two "Could not save your answers" toasts appear, then "Session saved. Resume it from the pack page…". After a reload the session shows 1 of 4 answered, so the newer answer is lost. With **Submit** in the same state, an uncaught exception (`pageerror full`) leaves the dialog open with Save and Submit both disabled. `ended` stays true, so the timer is frozen and nothing autosaves again. The session is dead until reload.

Expected: when a write fails, say so plainly, stay on the session, and keep both actions available.

Fix: in `session.tsx`, make `write()` return or throw a success flag. `saveForLater` and `finish` should check it, reset `ended.current = false` and `busy` on failure, and show one persistent error with "Export backup" instead of three toasts. Also, `app.tsx`'s `dmc:quota` toast and `write()`'s toast duplicate each other, so keep one.

#### F4. Esc, a backdrop click or Cancel anywhere in the import wizard throws away the pasted JSON and all review edits
Steps: paste a valid pack, choose Review import, enter time caps and titles, then press Esc (or click the dimmed backdrop). Reopen Import.

What happened: the wizard closes with no confirmation, and the textarea is empty when reopened. The same happens in "Make a pack with AI": its 12 fields reset on close.

Expected: a confirmation before discarding, or the draft kept until the import is committed.

Fix: in `src/ui/kit.tsx` `Modal`, add `confirmClose?: () => boolean` (or `dismissable={!dirty}`) and turn off backdrop dismissal for `size="full"` modals. In `app.tsx`, keep the import text and prompt fields in a module-level draft store (or `sessionStorage`, inside try/catch) that is cleared only after a successful import.

#### F5. Start dialog while a session is saved: focus stays behind the modal and Tab leaves it
Steps: save a session, then on the pack page focus another paper card with the keyboard and press Enter.

What happened: the dialog opens with Start disabled. Focus stays on the paper card behind the backdrop, and Tab moves to "Trend" on the page. The trap in `Modal` only wraps when focus is already on its first or last item. The dialog also gives no way to resolve the block (no Resume or Submit here).

Expected: focus goes into the dialog, and the dialog offers the fix.

Fix: in `kit.tsx` `Modal`, choose the first *enabled* element (`[autofocus]:not(:disabled)` and then `FOCUSABLE`), falling back to the dialog itself (`tabIndex=-1`). In the Tab handler, if `!el.contains(document.activeElement)`, move focus to the first item. In `start.tsx`, when `blocked` is true, render Resume and Submit-saved buttons in place of the disabled Start.

#### F6. Skip link is invisible when focused and does nothing
Steps: load any page and press Tab once (the focused element is "Skip to content"), then press Enter.

What happened: the link stays 1 × 1 px (`.sr-only` has no `:focus` rule), and focus stays on the link because `#main` is not focusable. On the session screen, nothing has `id="main"` at all. This fails WCAG 2.4.1 in practice, and 2.4.7.

Fix: in `src/styles/app.css`, add `.sr-only:focus { position: fixed; top: 8px; left: 8px; width: auto; height: auto; clip: auto; padding: 8px 12px; background: var(--surface-raised); z-index: 200; }`. Give every `<main>` `tabIndex={-1}`, and give `.qs-main` `id="main"` in `session.tsx`.

#### F7. Focus and announcements are lost on page and question changes
Steps and observations, all with the keyboard:
* After **Start**, focus is on `<body>` on the question screen. After **Next**, focus stays on Next and nothing announces "Question 3 of 40", so a screen reader user hears nothing.
* In strict per-question mode, the automatic move to the next question at zero is silent too.
* After an import, the app navigates to `#/pack/…?s=papers` with focus on `<body>`. Results pages and resumes also leave focus on `<body>`.
* On the pack page, **Start session**, the **Full paper** card and the section links (Overview, Start, Papers…) only scroll. The next Tab goes to the control after the button, not into the section (WCAG 2.4.3).

Timer announcements are correct: the live region announces only 50%, 25%, 10% and 1 minute. When two marks coincide (a 4-minute timer: 25% = 1 minute), only "One minute remains" is read, which is fine.

Fix: in `session.tsx`, focus `#qhead` (`tabIndex={-1}`) when `cur` changes and on mount. Alternatively, keep focus where it is and write "Question {n} of {N}" to a polite live region, separate from the timer's region. For strict auto-advance, announce "Time up for question {n}. Question {n+1}." In `app.tsx`, after each route change focus the page `h1` (with `tabIndex=-1`). In `pack.tsx`, the scroll handlers should also focus the section heading (`#start-h`, `#papers-h`…) or the first card.

#### F8. Paper cards hide their status from screen readers
Seen in axe as `label-content-name-mismatch` (serious) on every `.paper-card`.

What happened: `aria-label="{title}. Start"` (`papers.tsx`, card) replaces the visible content, so "Needs answer key", "12/40 questions", "In progress", "Weak", "Best 72%", attempts and time cap are never read. A screen reader user cannot tell which papers are ready, and "Start" is false for papers that are not ready.

Fix: remove the `aria-label`. Let the visible text form the name, or use `aria-labelledby` on the title plus `aria-describedby` on the meta and badges. Drop "Start" for papers that are not ready.

#### F9. Toasts cover the session controls, vanish in 5 s, pile up, and their buttons have no visible focus
Steps: import a pack and start a paper within 5 s (desktop 1280 × 720 or phone 390 px).

What happened: "Imported 4 questions." sits on top of **Previous** and **Next** at the bottom of the question screen (screenshot `session-dark.png`). A keyboard user's focus on Next is hidden (WCAG 2.4.11). Error toasts such as "Could not save your answers…" also disappear after 5 s (2.2.1), and we saw six toasts stacked at once. On a toast (`--inverse` background), the focus ring of its button is `--focus` = `#0D0E10` on `#0D0E10` in light (1:1), and orange on `#F3F2EE` in dark (2.77:1).

Fix: in `app.tsx`, do not render ordinary toasts on the session route, or place them at the top under `.qs-head`. Clear the toast queue on route change. Cap the queue at 2 and de-duplicate identical text. Keep error toasts and toasts with an action until dismissed, and give them a close button. In `app.css`, add `.toast :focus-visible { outline-color: var(--on-inverse); }`.

#### F10. In the question navigator, answered and unanswered look almost the same
Measured: answered cell `--surface-sunken` against unanswered `--surface-raised` is 1.20:1 in light and 1.12:1 in dark. The cell border `--line` against the page is 1.38:1. The legend's "12 answered" swatch has the same problem. This fails WCAG 1.4.11, on the control students rely on to find skipped questions before submitting.

Fix: in `app.css` `.qgrid button.answered`, use `background: var(--inverse); color: var(--on-inverse)` (the same language as a selected option), or add a filled corner or check shape. Use `--line-strong` for every cell border.

#### F11. Maths is read ambiguously by screen readers
What happened: `\frac{v}{λ}` is exposed as `math: "v λ"` (`content.tsx`: `role="math"` with no name), so ½ reads as "1 2". `\sqrt{2gh}` reads "√2gh" with no end. In table-layout options, the column headers are `aria-hidden`, so "speed m s-1" loses "quantity / unit".

Fix: in `src/ui/content.tsx`, give the fraction span `aria-label` "{num} over {den}" (from the token text), or insert sr-only " over " between the parts. For a root, add sr-only "square root of (" and ")". In `session.tsx`, label table-option cells with their column, for example sr-only "quantity: speed, unit: m s⁻¹".

#### F12. First visit reloads the page under the user
Steps: open DMC in a fresh profile.

What happened: `sw.js` runs `clients.claim()` on activate, and `main.tsx` reloads on every `controllerchange`, including the first install. On localhost the reload came about 200 ms after load. On a slow school or phone connection it can come seconds later, wiping a half-filled "Make a pack with AI" form or pasted JSON.

Fix: in `src/main.tsx`, record `const hadController = !!navigator.serviceWorker.controller` before registering, and reload on `controllerchange` only if `hadController` is true, or only after the user chose Update.

### Minor

#### F13. The radio-group keyboard model is unexpected
Options are `role="radio"` inside a `radiogroup`, but ↑ and ↓ do nothing. ← and → change the *question* even while focus is on an option, and every option is a separate Tab stop. A screen reader user hearing "radio button, 1 of 4" expects arrows to move between options.

Fix (`session.tsx`): either implement roving `tabIndex` with ↑ ↓ moving between options (and keep ← → for questions, announced through `aria-keyshortcuts` and the visible hint), or drop `role="radio"` and use `aria-pressed` buttons. Number and letter keys already work.

#### F14. The answer control in the fix dialog uses invalid ARIA
axe reports `aria-allowed-attr` (critical): `role="radio"` together with `aria-pressed` (`fix.tsx`, answer seg). Fix: remove `aria-pressed`, and add roving tabindex and arrow keys, or use plain `aria-pressed` buttons in a `group`.

#### F15. Strict per-question timer: the label shows "Q 0:00" for an instant and the auto-advance is silent
The per-question countdown is created in an effect after rendering, so the first frame of each question reads `qRemaining = 0` (`session.tsx`, `setQRemaining(rec?.qRemainingMs ?? 0)`). Fix: initialise it from `perQMs`. The announcement is covered in F7.

#### F16. "No limit" is not unlimited
In the Start dialog, the default timer option "No limit" counts down from the paper's cap: "Counts down from the 75-minute cap, which always applies". Fix (`start.tsx`): call it "Paper time (75 min)", or "Full time", which is honest and matches DECISIONS 27 and 36.

#### F17. Timer bar colours drift through an unrelated hue, and amber and red look alike to people with deuteranopia
The `color-mix(in oklch, warn x%, ok)` at 75% time is magenta (150, 64, 120) in light and green (59, 212, 164) in dark. Green reads as "good" while time is running out, and the two themes disagree. Simulated deuteranopia in light: 50% amber against 25% red-orange gives ΔE 2.4, so they are indistinguishable until the stripes appear at 10%. Contrast of the fill against the track is fine (4.6 to 10.7:1).

Fix (`session.tsx`): interpolate in `oklab` (no hue path), or step through three solid states (ok > 50%, warn 50–10%, bad < 10%). Add a second non-colour cue at 50% or 25% (for example, a notch or a pattern change).

#### F18. Some touch targets are under the 44 px design minimum at 390 px
Measured with touch emulation: "Fix this question" 157 × 36, "How is this calculated?" 198 × 36, "Dismiss tip" 42 × 36, section links "Start" 35 × 48 and "Data" 31 × 48, chip "All" 41 × 44, toast buttons 36 px tall. Chips and segmented buttons do reach 44 px under `pointer: coarse`. All targets pass WCAG 2.5.8 (24 px) but miss `--hit-min`.

Fix (`app.css`): make `.jy-btn--sm` 44 px tall under `@media (pointer: coarse)`, give `.secnav a` and `.chip` `min-width: 44px`, and make `.toast .jy-btn` 44 px tall.

#### F19. The mobile question screen layout is awkward
At 390 px the control row wraps: Flag, Unsure and an icon-only **Previous** sit on row 1 (Previous at the far right), and **Next** sits alone at bottom left (screenshot `m-session.png`). Keyboard hints ("F", "U") are shown on touch devices.

Fix (`app.css` `.qs-ctrl`): on narrow screens use two rows, with Flag and Unsure on one and Previous and Next on the other, Next on the right. Hide `.kbd` under `(hover: none)`.

#### F20. The Minutes and Seconds fields show unclamped values
Typing 99 into Minutes (cap 10) and tabbing away still shows "99", while the total reads 10:00. State was already 10, so nothing re-rendered. Fix (`start.tsx`): use controlled `value={String(minutes)}` with a key bump, or keep a local text state that is set from the clamped value on blur, and say "Capped at 10 min".

#### F21. "Copied" stays after the prompt changes
After copying, editing any field leaves the button saying "Copied", so the student may paste a stale prompt. Fix (`prompt.tsx`): `useEffect(() => setCopied(false), [prompt])`.

#### F22. The tabs in the prompt dialog are incomplete
"New paper" and "Answer key for a paper" use `role="tab"` with no `tabpanel`, no `aria-controls` and no arrow keys. The Close button is the last stop in the Tab order. Fix (`prompt.tsx`): reuse the pattern already in `insights.tsx`.

#### F23. The import status region is noisy and uses machine paths
The polite live region `#import-status` contains up to 50 error lines (2,448 characters measured for 40 errors), and it is re-read on every debounce. Errors read "papers[0].questions[2].options: Expected 4 options, found 3".

Fix (`import.tsx`): announce only the summary ("40 problems to fix") from a separate sr-only live node, and keep the list outside the live region. Show "Paper 1 (p1), Q3: expected 4 options, found 3" in the UI, and keep JSON paths only in the fix prompt.

#### F24. Review import: a blocked Import button gives no reason
Clearing "Pack name" disables Import with no message. The time-cap message is not linked to its inputs (`aria-invalid` without `aria-describedby`). Fix (`import.tsx`): list what is missing next to the button ("Name the new pack", "Set 1 time cap") and link the messages with `aria-describedby`.

#### F25. Corrupt files produce raw or misleading errors
* A non-zip renamed to `.zip`, or a truncated backup zip, gives the toast "invalid zip data".
* A zip with no JSON but a `readme.txt` is parsed as the pack: "Not readable: Unexpected "h" (line 1, column 1)".

Fix (`src/lib/data/files.ts`): wrap the fflate errors as "This zip is damaged or incomplete. Download or export it again". Look only for `*.json` (or `pack.json`) inside zips, and otherwise report "No pack JSON found in this zip". Tampered backups are handled well: "Checksum mismatch: the backup is corrupted or was edited".

#### F26. Time on the results page can exceed the time limit
After a simulated laptop sleep (wall clock +4 min) during a 5-minute exam, results show "6:42 time". Charging the timer is deliberate (DECISIONS 33), but per-question `timeMs` also absorbs the jump, which distorts pace analytics and the rushed-error baseline. Fix (`session.tsx` `attribute`): cap each stay at the timer's elapsed budget, `min(dt, countdown elapsed)`, and when the tab was hidden for more than 60 s, exclude that gap from `timeMs`.

#### F27. Charts are images with a title only
`role="img"` with labels such as "score trend over 5 sessions" (`charts.tsx`). The values are not available without sight. Fix: add a visually hidden `<table>`, or a "Show data" disclosure, under each chart.

#### F28. Typed confirmations do not accept Enter, and discard uses `confirm()`
Typing ERASE or DELETE and pressing Enter does nothing. "Discard" in the resume dialog and the pack notice uses a native `confirm()`, unlike the rest of the app. Fix: wrap the field and button in a `<form onSubmit>`, and use the app's `Modal` for discard.

#### F29. A progress-only backup restores onto a device without the packs, with no warning
On a fresh device, `dmc-progress-*.json` reports "Adds 1 session, 4 question stats", which point at a pack that does not exist. Fix (`data.tsx` `RestoreDialog`): if referenced pack ids are missing, warn "These stats belong to packs not on this device. Import the packs or a full backup first."

#### F30. The resume prompt and the End session dialog may hide timer announcements
While the End session modal is open (`aria-modal="true"`), the header live region sits outside the dialog. VoiceOver ignores content outside an aria-modal dialog, so a 1-minute warning can be lost. This was not verified with a real screen reader. Fix: render the announcer in a portal at the end of `body` that is never inside or behind a modal, or show the clock inside the End session dialog.

#### F31. Fix-question focus restore and stale state
Minor and observed only: after **Save** in the fix dialog, focus returns to "Fix this question". That is correct, but nothing confirms that the question changed. Add a status line in the question card ("Your fix is applied").

#### F32. Label in the backup panel
The three backup buttons read "Export" with `aria-label="Export everything"`. The busy text "Preparing…" is hidden behind the `aria-label`. Fix (`data.tsx`): use visible text "Export everything", or put `aria-busy` on the button.

#### F33. Random says nothing about repeats when the unseen pool runs low
After one random set, the card shows "63% unseen · 6 questions from across the pack, least-seen first" but not that some of the next set are repeats. Fix (`pack.tsx`): "6 questions: 4 new, 2 you have seen least".

## What works well

* Timer: anchored to an absolute end time with no drift (15.0 s of wall time = 14 s on the clock at ceil). A backward clock jump of 1 h does not add time, and a forward jump is charged as designed. Remaining time is frozen while saved. Auto-submit at zero works and is announced.
* Live region: exactly the four thresholds, no per-second chatter. `role="timer"` is not live.
* Double-click and triple-click on Submit create one submission. A late autosave never overwrote Save or Submit in these tests.
* Browser back mid-session saves and explains how to resume. Forward resumes. Reload on the session screen restores directly. Esc on the question screen does nothing, and Esc closes the top modal only.
* Offline after the first load: reload, start, submit, results and settings all work. Fonts are cached.
* Backups: SHA-256 checks reject edited zips and JSON, merges never delete, and a second device restores everything.
* Contrast of text tokens passes AA in both themes (ink-subtle 4.98:1 at worst on sunken). Status colours are always paired with a shape and a word.
* Reduced motion and "Reduce effects" stop the low-time pulse and chart animations.

## Method notes

Scripts and screenshots are in the session scratchpad (`/tmp/claude-0/-home-user-mcqengine/701b595c-11bd-5b61-bab0-60ab67bedf0d/scratchpad/ux/`), not in the repository. Storage-full behaviour was simulated by making `IDBObjectStore.prototype.put` and `add` throw `QuotaExceededError` on demand. Clock changes used Playwright's `page.clock.setSystemTime`, which moves `Date` but not `performance.now`. Colour-vision deficiency used Machado (2009) full-severity matrices on the resolved token colours, compared with CIELAB ΔE.
