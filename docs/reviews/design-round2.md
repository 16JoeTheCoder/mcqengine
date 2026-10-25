# DMC design review, round 2

Build: branch `ccr-7d4756bd-86dw39` at `da7fc0a` ("Fix design and accessibility findings from review round 1"), built fresh and served with `vite preview --port 4174`. I re-ran the same flows as round 1 on a newly built profile: 3-paper, 300-paper and zip packs; 5 baseline exam sessions plus a rushed one; timer at 100 / 50 / 10 / ~1 % and 0 %; practice; save and resume. Widths were 390, 820, 1440 and 2560 in light, plus 390 and 1440 in dark. At 2560 clicks went through `locator.evaluate(e => e.click())`, as the coordinator advised. I took 150+ new screenshots and measured overflow with a DOM pass on every screen. Screens and scripts are in `/tmp/claude-0/-home-user-mcqengine/701b595c-11bd-5b61-bab0-60ab67bedf0d/scratchpad/design/` (`shots2/`, `cap2.mjs`).

**Verdict:** all three Criticals from round 1 are fixed. The overflow pass found no horizontal overflow at any width. At 2560 the question controls sit at y = 453 in a 1440 viewport, and About at 390 shows the whole signature. The global grid-stretch bug, the segmented controls, practice feedback, dark answered cells and the disabled caps are fixed too. What remains is mostly second-order polish. However, the fixes introduced **two new Major defects**: the prompt dialog's sticky action bar overlaps its own note on desktop, and image-only questions shrink to an illegible thumbnail at 390.

## Decisions 67–83: my position

| Decision | Judgement |
| --- | --- |
| 74, timer drains from the left per the brief, adds "Low" word, sRGB mix | Accepted. The brief wins; #33 is closed. The "Low" word is hidden at ≤ 640 px (`hide-sm`), which re-opens part of #32 on phones (see R8). |
| 76, Next and Finish plain on the question screen | Accepted for the orange rule. **New argument:** Next is now visually identical to Previous, so the most-used action has no weight. Use the inverse fill *without* the cap; this keeps one orange point (R12). |
| 79, time capped at the session budget | Accepted; verified (1:15:00 on a 75-minute paper). |
| 80, "Full time (75 min)" | Accepted. The label, the help text and the "Total 1:15:00" line now say the same thing three times (R10). |
| 81, hover lifts gated, ease-in exit | Accepted; verified in CSS. |
| 82, zoom kept, viewport units divided by 1.25 | Accepted; verified at 2560 (the screen fits, modals fit). The header still spans 2560 px while content is capped (R13). |
| 83, nested 7 px radii, 14 px tab/table text, no modal exit | Accepted without a new argument. #27 (14 px part), #29 and #48 are closed. |
| 67–73, 75, 77, 78 | No design objection; 73 and 77 verified visually in both themes. |

## Status of the 50 round-1 defects

Fixed 31 · Partly 13 · Not fixed 4 · Accepted by decision 2 (#33, #48; #27 and #29 accepted in part).

| # | Defect | Status | Note |
| --- | --- | --- | --- |
| 1 | Question screen overflow at 390 | **Fixed** | No overflow; 2 × 2 control grid. Keyboard hints still show on touch (R15). |
| 2 | 2560 question screen off-screen | **Fixed** | Controls at y = 453 / 1440. Header still full width (R13). |
| 3 | About crops logo at 390 | **Fixed** | |
| 4 | Grid stretch (`align-content`) | **Fixed** | |
| 5 | Segmented controls stretch | **Fixed** | At 390 the Timer seg now wraps "Per question" to a second line (R9). |
| 6 | Verdict void | **Fixed** | |
| 7 | Unitless rings | **Fixed** | "83 %", "3/3", "0/300". "0/300" is cramped in a 56 px ring (R14). |
| 8 | Trend y-domain clips data | **Partly** | Top extended to 100, but the 55 % point still sits below the lowest (60) gridline with no tick, at 390 / 1440 / 2560 (R4). |
| 9 | Feedback colour and size | **Fixed** | |
| 10 | Wrong-selected contrast | **Fixed** | Both themes. |
| 11 | Dark answered cells | **Fixed** | |
| 12 | Import review at 390 | **Fixed** (390) / **Partly** (desktop) | Stacked cards at 390. Desktop "Apply to all" is still centred mono text, and the status badge still sits 10 px above the input midline (R11). |
| 13 | Prompt dialog CTA below fold | **Partly** | Desktop has a sticky column but a new overlap bug (R1). At 390 Copy prompt is still about 1400 px down; the sticky bar only sticks inside its own column, which comes after the form (R1). |
| 14 | Library cards | **Partly** | "Next:" line, plural, thin-space thousands and "Not practised yet" are in. A finished pack (Demo Physics) still has an empty middle, and the internal rows misalign between cards (R5). |
| 15 | Controls far from options | **Fixed** | |
| 16 | Image-only option rows | **Fixed** at ≥ 820 / **Regressed** at 390 | Letters row is good; the image itself collapses to about 120 px tall on phones (R2). |
| 17 | KPI baselines | **Partly** | Unit spacing fixed. "Sessions done" delta still sits at y = 411 against 420 in the other tiles. At 390 the arrows still centre on two-line deltas and padding is still 24 px (R3). |
| 18 | Disabled cap/fill | **Fixed** | |
| 19 | Hover gating, sweep exit | **Fixed** | |
| 20 | Time over cap | **Fixed** | |
| 21 | Start dialog jump | **Fixed** | It now reserves an empty ~100 px band under "Full time" (R10). |
| 22 | "No limit" wording | **Fixed** | Redundancy remains (R10). |
| 23 | Slider/field alignment | **Fixed** | |
| 24 | Strict checkbox | **Partly** | No longer shrinks, but still centres on a 2–3 line label (R16). |
| 25 | Footer button heights | **Fixed** | |
| 26 | Text under 12 px | **Partly** | `charts.tsx:282` is still `fontSize: '11px'`; the ring "%" tspan floors at 10 px (R17). |
| 27 | Off-scale sizes | **Partly / accepted** | 14 px is accepted (Decision 83). `.qtext` line-height 1.55 and `.opt .ot` 1.45 remain off the 4 px grid (R17). |
| 28 | Fraction line spacing | **Partly** | The fraction is now very small and sits low. Line 1 → 2 is still about 40 px against 31 px in Results and the import preview (R17). |
| 29 | Radii count | **Accepted** (Decision 83) | |
| 30 | 6 px gaps | **Partly** | `.jy-field` fixed; `.qgrid`, `.chip`, `.jy-badge` still 6 px (R17). |
| 31 | Legend and flag badge | **Fixed** | |
| 32 | Low clock colour-only | **Partly** | "Low" word at ≥ 641 px only (R8). |
| 33 | Timer drain direction | **Accepted** (Decision 74) | |
| 34 | Mobile top bar order, signature inset | **Not fixed** | Gear still floats mid-bar at 390. `.signature` padding still 4 px, so the lockup sits inside the gutter (R18). |
| 35 | Settings centred | **Fixed** | Backup cards now misalign their Export buttons (R19). |
| 36 | Chip heights | **Fixed** | The sort select is still unlabelled ("Title") (R19). |
| 37 | Paper-card meta wraps | **Not fixed** | "2 days ago" still drops to its own line on one card (R7). |
| 38 | Insights duplicates trend, double underline nav | **Not fixed** | (R6) |
| 39 | Heatmap tiny, unlabelled | **Not fixed** | Still about 250 px of a 560 px panel at 1440, and the same at 2560 (R6). |
| 40 | Table date wraps at 390 | **Fixed** | |
| 41 | Dashed box in panel | **Fixed** | |
| 42 | Rushed chips | **Fixed** | "10.0" with the unit pushed into the caption reads oddly (R20). |
| 43 | Results ring at 390 | **Partly** | 96 px, but still stacked above the title, and the stat row still wraps unevenly (R20). |
| 44 | Figure scaling | **Fixed** | In dark, the paper well is still a full-width bright block around the 560 px image (R21). |
| 45 | Add-card | **Fixed** | |
| 46 | "Back up everything" floating h3 | **Partly** | Spacing improved; still a heading outside any panel between panels (R19). |
| 47 | Copy contradictions | **Fixed** | |
| 48 | Modal exit motion | **Accepted** (Decision 83) | `.opt:active` press feedback is still missing (R12). |
| 49 | Two orange caps on the question screen | **Fixed** | (see R12) |
| 50 | Onboarding buttons, floating footer | **Partly** | Block buttons at 390 are in; the footer still floats mid-screen on short pages at 1440 / 2560 (R18). |

## Scores, round 2 (round 1 in brackets)

| Screen | Hier. | Spacing | Align | Type | Colour | Consist. | Motion | Empty | Polish | Worst width |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Library, empty | 8 (8) | 8 (7) | 8 (8) | 8 (8) | 9 (9) | 8 (8) | 9 (8) | 8 (7) | 8 (7) | |
| Library, with packs | 8 (7) | 7 (6) | 7 (8) | 8 (7) | 9 (8) | 7 (7) | 9 (7) | — | 7 (6) | 390: 7 (5) |
| Pack: overview | 8 (7) | 7 (6) | 7 (6) | 8 (7) | 8 (7) | 8 (7) | 9 (8) | 8 (8) | 7 (6) | 390: 6 (5) |
| Pack: start | 8 (8) | 8 (8) | 8 (8) | 8 (8) | 8 (8) | 8 (8) | 9 (8) | 8 (8) | 8 (7) | |
| Pack: papers (3) | 7 (7) | 7 (6) | 7 (6) | 8 (7) | 8 (8) | 7 (6) | 9 (8) | 8 (8) | 7 (6) | |
| Pack: papers (300) | 8 (7) | 8 (7) | 8 (7) | 8 (7) | 8 (8) | 8 (7) | 9 (8) | 8 (8) | 8 (7) | |
| Pack: insights | 6 (6) | 6 (6) | 7 (7) | 8 (7) | 8 (8) | 6 (6) | 9 (8) | 8 (7) | 6 (6) | |
| Pack: data | 7 (7) | 7 (7) | 7 (7) | 8 (8) | 8 (8) | 7 (6) | 9 (8) | 8 (8) | 7 (7) | |
| Prompt dialog | 7 (7) | 7 (5) | 6 (5) | 8 (7) | 8 (7) | 7 (6) | 9 (8) | 7 (6) | 6 (5) | 390: 5 (4) |
| Import wizard, input | 8 (8) | 8 (7) | 8 (8) | 8 (8) | 9 (8) | 8 (7) | 9 (8) | 8 (7) | 8 (7) | |
| Import wizard, review | 8 (7) | 7 (6) | 7 (6) | 7 (6) | 8 (8) | 7 (6) | 9 (8) | — | 7 (6) | 390: 8 (3) |
| Start dialog | 8 (8) | 7 (6) | 8 (6) | 8 (8) | 8 (8) | 8 (7) | 9 (6) | — | 7 (6) | 390: 6 |
| Question screen, exam | 8 (8) | 8 (6) | 8 (8) | 8 (7) | 9 (7) | 8 (7) | 8 (8) | — | 8 (7) | 390: 8 (2), 2560: 8 (2) |
| Timer states | 9 (8) | — | 8 (8) | 8 (8) | 9 (7) | 8 (8) | 8 (7) | — | 8 (7) | 390: 7 |
| Practice feedback | 9 (6) | 8 (7) | 8 (7) | 9 (6) | 9 (4) | 8 (6) | 8 (7) | — | 8 (5) | |
| Image-only question | 8 | 8 | 8 | 8 | 9 | 8 | 8 | — | 8 | **390: 4** |
| End-session modal | 9 (8) | 8 (8) | 8 (8) | 8 (8) | 9 (8) | 9 (8) | 8 (8) | — | 9 (8) | |
| Resume prompt | 9 (8) | 8 (8) | 8 (8) | 8 (8) | 9 (9) | 9 (8) | 8 (8) | — | 9 (8) | |
| Results | 8 (7) | 8 (7) | 8 (8) | 8 (7) | 9 (8) | 8 (7) | 9 (8) | — | 8 (7) | 390: 7 (6) |
| Rushed-error panel | 8 (7) | 8 (7) | 8 (8) | 8 (7) | 9 (8) | 8 (6) | 9 (8) | — | 8 (7) | |
| Settings | 8 (7) | 8 (8) | 7 (6) | 8 (8) | 9 (9) | 8 (7) | 9 (8) | — | 8 (7) | |
| About | 9 (8) | 8 (7) | 9 (6) | 8 (8) | 9 (9) | 9 (8) | 8 (8) | — | 9 (7) | 390: 9 (3) |
| Dark theme overall | 8 (7) | — | — | — | 8 (6) | 8 (7) | — | — | 8 (7) | |

Every score below 9 maps to a defect below.

## Remaining and new defects, ordered by impact

### Major

**R1. New: the prompt dialog's sticky action bar is broken on desktop, and it does nothing on phones.**
At 1440 the `.sticky-actions` bar inside the right `.sticky-col` keeps its full-modal negative margins (`margin: 0 -24px -24px`). Its top hairline runs from the column gap to the modal edge (x = 708–1268), and its opaque background covers the privacy note ("Nothing leaves your device…" is cut through). At 390 the bar sits in the second column, after nine fields, so Copy prompt is still about 1400 px below the fold.
Fix (`src/screens/prompt.tsx`, `src/styles/app.css`):
- Move the actions out of `.sticky-col` to a direct child of `.modal`, after the grid, so the full-width negative margins are correct and `position: sticky; bottom` works on every width.
- At ≥ 900 px, keep a plain `.row` (no `.sticky-actions`) under the preview inside the sticky column.
- Put the privacy note *above* the buttons, so nothing can cover it.

**R2. New regression: image-only questions are illegible at 390.**
The whole-question screenshot renders about 300 × 120 px (text about 9 px) above the new letter row. `.qs-col` now uses `grid-template-rows: minmax(0, max-content) auto`, so `.qimage` (`flex: 1 1 auto; min-height: 120px`) collapses to its minimum. At 820 / 1440 it is fine.
Fix: `.qimage { flex: none; } .qimage img { width: 100%; height: auto; max-height: none; }`. Let `.qcard` scroll, which it already does, and add tap-to-zoom on the image for phones.

**R3. KPI tiles are still off-baseline (round 1 #17).**
The "Sessions done" delta sits at y = 411 against 420 in the three tiles with units. At 390 the arrow centres on two-line deltas and the 24 px padding squeezes the text.
Fix:
- `.jy-stat .value { display: flex; align-items: baseline; height: 48px; }`
- `.jy-stat .unit { line-height: 1; }`
- `.jy-stat .delta { align-items: flex-start; } .jy-stat .delta svg { margin-top: 3px; }`
- `@media (max-width: 480px) { .kpis .jy-panel { padding: var(--space-4); } }`

**R4. Trend chart still plots a point outside its axis (round 1 #8).**
55 % is drawn below the 60 gridline with no tick, on the overview trend at every width. Extending the top to 100 did not address the bottom.
Fix (`src/ui/charts.tsx`): `yMin = floor(min(points, bandLow) / 10) * 10`, and draw ticks at every 10 or 20 from `yMin` to 100.

**R5. Library cards still have no consistent internal grid (round 1 #14).**
The "Next:" line sits at y = 402 on one card and y = 362 on the next. On the 300-paper card the meta wraps so "Not practised yet" takes its own row. The finished pack (Demo Physics) still has an empty middle with no last result. Meta now sets the words in mono too ("300 papers"), while "Today" is sans.
Fix (`src/screens/library.tsx`, `.pack-card`):
- Use `grid-template-rows: auto 1fr auto` with three fixed rows: header; a status line ("Next: …" or "Last: 55 % · 2026-10-29" when every paper is done); meta.
- Keep meta on one line (`flex-wrap: nowrap; overflow: hidden; text-overflow: ellipsis`), and move recency into the status line.
- Wrap only the numbers in `.num`.

**R6. Insights is still the weakest section (round 1 #38, #39).**
- The Trend tab repeats the overview chart about 600 px above it.
- The tabs are a second underline nav directly under the sticky underline section nav.
- The activity heatmap is about 250 px wide in a 560 px panel (also at 2560), with no weekday or month labels.

Fix:
- Drop the Trend tab, or make it the "true scale plus range" variant only.
- Render the tabs as `.seg`.
- Size heatmap cells to the panel width (`cell = (width - 32) / 18`, max 24 px), and add Mon / Wed / Fri and month labels at 12 px.

### Minor

**R7. Paper cards: meta still wraps inconsistently (#37).** "2 days ago" is on its own line on one card but inline on its neighbour, so badges sit at different heights. Put recency on a fixed second row in every card (`.paper-card .m + .m`), or show it as the card's last line in all cases.

**R8. The low-time "Low" word is hidden on phones (#32).** In `session.tsx:427`, drop `hide-sm` and use the 8 px diamond plus "Low" at 12 px. It fits: the bar row has 120 px spare at 390.

**R9. New: the start dialog's Timer seg wraps at 390.** "Per question" drops to a second line inside the bordered seg. Fix: at ≤ 640 px, `.seg { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; width: 100%; }`, and shorten the first label to "Full time".

**R10. New: the start dialog reserves an empty ~100 px band under "Full time".** That is the side effect of preventing the jump, and the copy is redundant: label "Full time (75 min)", help "The full time allowed for this paper, 75 minutes.", then "Total 1:15:00". Fix: reserve only one 44 px row (the slider row) and render a one-line summary in it for Full time ("Counts down from 1:15:00"). Delete the duplicate help sentence.

**R11. Import review, desktop (#12).** "Apply to all" is still centred mono text under the time cap, and the status badge is top-aligned 10 px above the input midline. Fix: make "Apply to all" a `jy-btn--ghost jy-btn--sm` in sans, right after the first time-cap input; give the table `td { vertical-align: middle }` for the input row, or wrap the badge in a 44 px-tall flex box.

**R12. Next has no weight on the question screen (new argument on Decision 76), and options have no press feedback (#48).** Next and Previous are identical outline buttons. Fix: `.qs-ctrl .jy-btn--next { background: var(--inverse); color: var(--on-inverse); border-color: var(--inverse); }` with no `::before` cap, so there is still one orange point. Also add `.opt:active:not(:disabled) { transform: translate(1px, 1px); }`.

**R13. The question header spans the full 2560 px while content is capped at 1440** (#2 remainder): title at x = 24, clock at x ≈ 2350. Fix: `.qs-head .bar-row { max-width: 1440px; margin: 0 auto; }` to match `.qs-main`.

**R14. New: the current-cell ring in the sidebar grid is clipped.** `box-shadow: 0 0 0 2px surface, 0 0 0 4px ink` extends 4 px outside the cell, and `.qs-side { overflow: auto }` cuts it on the left column (Q1, Q6, Q11…), visible at 1440 and 2560. Also, "0/300" is cramped inside a 56 px ring. Fix: `.qs-side { padding: 4px; margin: -4px; }`, or draw the ring with `outline: 2px solid var(--ink); outline-offset: 2px` inside a padded container. For rings with long text, use `size={64}` or show "0 %" with "0/300" in the meta.

**R15. Keyboard hints still render on touch** (#1 remainder). Add `@media (pointer: coarse) { .kbd { display: none; } }`.

**R16. The Strict checkbox still centres on a 2–3 line label** (#24). Fix: `.check { align-items: flex-start; } .check input { margin-top: 3px; }`.

**R17. Type and grid leftovers** (#26, #27 in part, #28, #30):
- `charts.tsx:282 fontSize: '11px'` → 12 px; the ring "%" tspan floor of 10 px → 12 px, or drop the separate size.
- `.qtext { line-height: 1.55 }` → fixed 28 px; `.opt .ot { line-height: 1.45 }` → 24 px.
- `.mk-frac`: 0.8 em with a −0.45 em offset now reads as a subscript and still opens the line. Use `font-size: 0.85em; vertical-align: -0.6em; line-height: 1` and give `.qtext` `line-height: 32px` when it contains a fraction (`:has(.mk-frac)`).
- 6 px gaps in `.qgrid`, `.chip` and `.jy-badge` → 8 px or 4 px.

**R18. Shell leftovers** (#34, #50):
- At ≤ 640 px the gear floats mid-bar; move it after the signature (`order: 2` on the gear at ≤ 640 px).
- `.signature { padding: 0 }` so the lockup aligns with the gutter in the top bar and footer.
- The footer still floats mid-viewport on short pages at 1440 / 2560: `body > #app { display: flex; flex-direction: column; min-height: 100vh } main { flex: 1 }`, or the equivalent root wrapper.

**R19. Settings and Data details** (#35, #36, #46):
- The backup cards' Export buttons misalign (the "Everything" button sits 18 px lower because its text wraps to 3 lines). Fix: `.backup-card { display: flex; flex-direction: column } .backup-card .jy-btn { margin-top: auto }`.
- "Back up everything" is still a heading floating between panels; put the three tiers inside one `jy-panel` with that h3.
- The paper sort select still reads just "Title"; render "Sort: Title", or add a visible label.

**R20. Results details** (#42, #43):
- "Accuracy drop" shows "10.0" as the number with "questions, 25.0 points below your median" as the caption. Show "10 Q" (integer) as the figure and "25 points below your median" as the caption.
- At ≤ 640 px put the 96 px ring inline left of the title (`.score-hero { grid-template-columns: 96px 1fr }`), and lay the three stats out as a 2-column grid instead of wrapping prose.

**R21. Dark: the figure well is still a full-width bright paper block** around a 560 px image (#44 remainder). Fix: `.fig { display: flex; justify-content: center; background: var(--surface-sunken); } .fig img { background: var(--brand-paper); border-radius: var(--radius-sm); padding: var(--space-2); }`, so only the image itself is paper-white.

**R22. New, 820 px: the grid sheet modal left-aligns a 252 px grid in a 560 px modal**, leaving a 260 px dead band. Fix: centre `.qgrid` in the sheet (`justify-content: center`), or use 8 columns at ≥ 600 px.

## What is now at 9+

End-session and resume modals, About at every width, practice feedback colours in both themes, the question screen at 390 / 820 / 1440 / 2560 (layout), dark answered state, disabled buttons, motion rules (hover gating, sweep exit, reduced motion), and token discipline.
