# DMC design review, round 1

Reviewer stance: senior product designer, judged against `docs/design/DESIGN.md` + `tokens.css` and the deliberate choices in `docs/DECISIONS.md`. Build reviewed: `npm run build` at 2026-10-24, `vite preview` on :4174, Chromium (Playwright 1.63).

Coverage: 257 screenshots at 390 / 820 / 1440 / 2560 px, light everywhere, dark at 390 and 1440 (plus empty library at all widths). States: empty onboarding, library with 3 packs (3-paper, 300-paper, zip pack with screenshots), pack page at every section, paper browser with 3 and 300 papers, prompt dialog, import wizard (empty, syntax error, schema errors, valid, review), start dialog (No limit / Fixed total / Per question / Practice), question screen (typed, table, SVG figure, needs-figure, file figure, image-only), timer at 100 / 50 / 10 / ~1 % and after auto-submit at 0, practice feedback (right and wrong), end-session modal, resume prompt, results, rushed-error panel (5 baseline exam sessions, then a faster, worse one), settings, About, hover states. Screens and scripts: `/tmp/claude-0/-home-user-mcqengine/701b595c-11bd-5b61-bab0-60ab67bedf0d/scratchpad/design/`.

Overall: the token discipline is real (one raw hex in the codebase, for `theme-color`), type and colour are on-standard, and the desktop library, pack page, results and modals look like a credible product. The app is not shippable as a paid product yet. **Three layout failures break core screens at real widths**: the question screen at 390 px, the question screen and every modal at 2560 px, and About at 390 px, where the signature logo gets cropped. Beyond those, one global grid bug (`align-content` / `justify-items` stretch) causes most of the "something is off" feel across dialogs and panels.

## Scores

Scale 1–10. A dash means the criterion does not apply. Each screen's worst width is noted where it differs from desktop.

| Screen | Hier. | Spacing | Align | Type | Colour | Consist. | Motion | Empty | Polish | Worst width |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Library, empty onboarding | 8 | 7 | 8 | 8 | 9 | 8 | 8 | 7 | 7 | |
| Library, with packs | 7 | 6 | 8 | 7 | 8 | 7 | 7 | — | 6 | 390: 5 |
| Pack: overview (KPIs, trend, verdict) | 7 | 6 | 6 | 7 | 7 | 7 | 8 | 8 | 6 | 390: 5 |
| Pack: start | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 7 | |
| Pack: papers (3) | 7 | 6 | 6 | 7 | 8 | 6 | 8 | 8 | 6 | |
| Pack: papers (300) | 7 | 7 | 7 | 7 | 8 | 7 | 8 | 8 | 7 | |
| Pack: insights | 6 | 6 | 7 | 7 | 8 | 6 | 8 | 7 | 6 | 390: 5 |
| Pack: data | 7 | 7 | 7 | 8 | 8 | 6 | 8 | 8 | 7 | |
| Prompt dialog | 7 | 5 | 5 | 7 | 7 | 6 | 8 | 6 | 5 | 390: 4 |
| Import wizard, input / errors | 8 | 7 | 8 | 8 | 8 | 7 | 8 | 7 | 7 | |
| Import wizard, review | 7 | 6 | 6 | 6 | 8 | 6 | 8 | — | 6 | 390: 3 |
| Start dialog | 8 | 6 | 6 | 8 | 8 | 7 | 6 | — | 6 | |
| Question screen (exam) | 8 | 6 | 8 | 7 | 7 | 7 | 8 | — | 7 | **390: 2, 2560: 2** |
| Timer states (100/50/10/0 %) | 8 | — | 8 | 8 | 7 | 8 | 7 | — | 7 | |
| Practice feedback | 6 | 7 | 7 | 6 | 4 | 6 | 7 | — | 5 | dark: 4 |
| End-session modal | 8 | 8 | 8 | 8 | 8 | 8 | 8 | — | 8 | |
| Resume prompt | 8 | 8 | 8 | 8 | 9 | 8 | 8 | — | 8 | |
| Results | 7 | 7 | 8 | 7 | 8 | 7 | 8 | — | 7 | 390: 6 |
| Rushed-error panel | 7 | 7 | 8 | 7 | 8 | 6 | 8 | — | 7 | |
| Settings | 7 | 8 | 6 | 8 | 9 | 7 | 8 | — | 7 | |
| About | 8 | 7 | 6 | 8 | 9 | 8 | 8 | — | 7 | **390: 3** |
| Dark theme (overall) | 7 | — | — | — | 6 | 7 | — | — | 7 | |

Every score below 9 maps to one or more defects below.

## Defects, ordered by impact

### Critical

**1. The question screen overflows horizontally at 390 px, so End session, Previous and the right edge of the question card are clipped.** Question screen, 390 light and dark, all question types.
Measured: `.qs-head`, `.qs-main` and `.timer` are 433 px wide in a 390 px viewport. `body { overflow-x: hidden }` hides the scrollbar, so the content is simply cut off. The cause is that `.qs` (a grid with no column template) and `.qs-main` (`grid-template-columns: 1fr`) size to min-content. On top of that, `.qs-ctrl` wraps: Next drops alone to a second row and Previous sits off-screen.
Fix (`src/styles/app.css`):
- `.qs { grid-template-columns: minmax(0, 1fr); }`
- `.qs-main { grid-template-columns: minmax(0, 1fr); }`
- `.qs-head .bar-row > * { min-width: 0 }`
- At `max-width: 640px`, show End session as an icon button (or the label "End"), and make `.qs-ctrl` a grid: `grid-template-columns: auto auto 1fr; ` with Flag, Unsure, then a Prev + Next group, Next `flex: 1`, Previous icon-only (it already hides its label via `.hide-sm`).
- Hide `.kbd` hints under `(pointer: coarse)`.

**2. At 2560 px the question screen is 1800 px tall in a 1440 px viewport, so Flag, Unsure, Previous and Next are off-screen.** Question screen, 2560 light (dark the same). Modals are affected the same way.
Measured: `.qs` height 1800, control bottoms at y = 1780. `@media (min-width: 2200px) { body { zoom: 1.25 } }` (Decision 12) multiplies every `dvh` / `vh` length by 1.25. That breaks `.qs { height: 100dvh }`, `.modal { max-height: calc(100dvh - 32px) }`, `.fig { max-height: 42vh }` and `.qs-main` sizing. The header also scrolls away, taking the clock with it.
Fix: inside the same media query, add `.qs { height: 80dvh; } .modal { max-height: calc(80dvh - 26px); } .fig { max-height: 33.6vh; }`. The cleaner fix is to drop `body { zoom }` and scale with `html { font-size }` plus `--page-max: 1440px` at ≥ 2200 px. The question screen also ignores the 1200 px standard: `.qs-main { max-width: 1440px }` while the header spans the full 2560 px (title at x = 24, clock at x = 2480). Constrain `.qs-head .bar-row` to the same max width as `.qs-main`.

**3. About at 390 px crops the builtbyjosef signature and clips every text column on the right.** About dialog, 390 light and dark.
The 96 px lockup renders about 360 px wide (`style={{ height: 96px, width: auto }}` in `src/ui/brand.tsx`, `Signature`), and the modal's grid content grows to that min-content width. You see "builtbyjose", "Built to" and "Nothing is uploa…". This damages the brand signature on the one screen meant to show it large.
Fix:
- In `Signature`, add `maxWidth: '100%', objectFit: 'contain', objectPosition: 'left center'` to the img style.
- Add `.modal > * { min-width: 0 }`.
- At ≤ 640 px use height 64 (still large, and above the 40 px lockup minimum).

### Major

**4. Global grid stretch bug: `.stack`, `.stack-s` and `.jy-field` distribute spare height between rows.** Prompt dialog (Subject input 58 px tall next to a 46 px Pack name input, Paper title 52 px, so the rows don't line up), import review preview cards (Q1 card with about 80 px of air above the stem), About ("Your data" body 48 px below its label against 26 px elsewhere), Verdict panel (see #6).
Fix (`app.css`): `.stack, .stack-s, .jy-field { align-content: start; }`, and `.input, .select { height: var(--hit-min); }` so inputs never stretch.

**5. Segmented controls stretch to the full field width, with the options crammed left and a dead empty bar to the right.** Start dialog (Mode, Timer), prompt dialog (Options per question, Diagrams), Settings > Theme, all widths.
Cause: `.jy-field` is a grid with `justify-items: stretch`, so the inline-flex `.seg` becomes a block.
Fix: `.jy-field > .seg { justify-self: start; }`. Or, if a full-width control is wanted, `.seg button { flex: 1 }`. Pick one; don't do half of each.

**6. The Verdict panel has a 120 px void above "Flat, within noise" and another void below it.** Pack overview, 1440 and 2560.
The panel is stretched to the trend panel's height and its content is distributed vertically.
Fix: `align-content: start` on the panel's inner stack (see #4). Then put the explanatory paragraph directly under the badge, 16 px gap.

**7. Rings show a bare number with no unit, and the same component means different things.** Library cards ("100", "0"), paper cards ("83", "–"), Coverage ("100"), results hero ("55", "0").
On the library card the ring is *papers done*; on a paper card it is *best score*; on results it is *paper score*. None says which, and none carries a % sign.
Fix (`src/ui/kit.tsx`, `Ring`):
- Render `{n}<tspan font-size="0.55em">%</tspan>`.
- Add a 12 px uppercase label under rings of 120 px and larger ("papers done", "paper score").
- On library cards replace the ring text with `3/3`.
- Raise the minimum ring text to 12 px: `font-size={Math.max(12, size * 0.26)}`. It is 11.4 px at size 44 now.

**8. The trend chart's y-domain clips data: session 6 (55 %) is drawn below the 60 gridline, in the x-axis label zone, with no tick under it.** Pack overview trend, all widths.
Fix (`src/ui/charts.tsx`, line chart scale): compute the domain from min and max of raw points *and* band, `nice()` it to 10s, and always draw a gridline at the bottom of the domain.

**9. Practice feedback loses its status colour and is set too small.** Practice mode, all widths and themes.
`.feedback` (line 337) is declared after `.notice--bad` (line 172) with equal specificity, so its `border: 1px solid var(--line-strong)` wins and the box is grey whether you were right or wrong. The verdict text is the 12 px badge ("Incorrect. The answer is B").
Fix:
- Change the selectors to `.feedback.notice--bad { border-color: var(--status-bad) } .feedback.notice--ok { border-color: var(--status-ok) }`.
- Render the sentence at body 15/24, weight 500, with the badge shape in front.

**10. A wrong selected option puts status-bad text on the inverse fill, which fails contrast.** Practice feedback.
Light: #C41E3A on #0D0E10 ≈ 3.3:1 for 12 px "Your answer". Dark: #FF6B7F on #F3F2EE ≈ 2.6:1.
Fix: once checked, an option leaves the inverse style. `.opt.wrong[aria-checked="true"] { background: var(--surface-raised); color: var(--ink); }` keeps the 2 px red border and the diamond. Also drop the orange cap on checked-wrong, since the orange point should not mark an error.

**11. Dark theme inverts the answered state in the question grid: answered (`surface-sunken` #08090A) is darker than unanswered (`surface-raised` #16181B), so answered cells look *less* filled.** In light the difference is #E8E6E0 against #FBFAF7, about 1.2:1, which is barely visible either way. Question screen sidebar and the mobile grid sheet.
Fix (`.qgrid button.answered`): use `background: var(--inverse); color: var(--on-inverse); border-color: var(--inverse);`. Keep current = 2 px ink ring with 2 px offset, so it stays distinct from answered.

**12. Import review at 390 px becomes a horizontally scrolling table inside a modal, with titles truncated ("May/June 2025 Paper").** Import wizard review, 390.
Fix (`src/screens/import.tsx` review table plus CSS): at ≤ 640 px render each paper as a stacked card (Title, Group, Questions + Time cap side by side, status badge top right). Move "Apply to all" next to the first time-cap input as a ghost sm button, not centred mono text under it. Also top-align the status badge with the inputs (now 10 px high).

**13. The prompt dialog at 390 px puts the main action (Copy prompt) about 1400 px below the fold, after nine fields.** At 1440 it leaves a large dead right column under a nearly empty preview well.
Fix (`src/screens/prompt.tsx`):
- Make `.modal-foot` sticky (`position: sticky; bottom: calc(-1 * var(--space-5)); background: var(--surface-raised); padding-block: var(--space-3); border-top: 1px solid var(--line)`) and move Copy prompt / Import the reply there.
- At desktop make the right column `position: sticky; top: 0`.
- Replace the empty-preview sentence with a dimmed skeleton of the prompt, so the well does not read as broken.

**14. Library pack cards are 208 px tall with a dead middle and no next action, and the three demo packs read identically.** Library, all widths. At 390 that is three full-screen-height cards.
Fix (`src/screens/library.tsx`, `.pack-card`): fill the middle with the last result (`Last: 55 % · 2026-10-29`) or "Not started". Show a "Resume" badge or primary affordance when `saved`. Drop `min-height` to 160 px at ≤ 640 px. Fix the copy too: "1 papers" → pluralise; "Never" → "Not started"; "3000 questions" → "3 000 questions" (thin space, as the standard requires). The card `h2` has inline `22px/28px`, which is off-scale; use the h3 token (18/26) or h2 (24/32).

**15. Question card controls sit far from the options on desktop.** At 1440×900 the options end at y = 378 and Next is at y = 862, so every answer → Next mouse trip is about 480 px, under a large empty card.
Fix (`.qs-col` / `.qcard`): `.qs-col { grid-template-rows: auto auto; align-content: start; }` and `.qcard { max-height: calc(100dvh - var(--top-h) - 120px); }` so short questions keep controls right under the options. Long questions still scroll inside the card.

**16. The image-only question still renders four full-width "Option A…D" rows, duplicating the A–D inside the screenshot and pushing the controls down.** Question screen with a whole-question image.
Fix (`src/screens/session.tsx`): when `q.image` and the options have no text, render `.options` as a single row of letter buttons (`grid-template-columns: repeat(n, minmax(0, 1fr))`, 52 px tall, letter only).

**17. KPI tiles: delta lines do not share a baseline.** "Sessions done" delta at y = 411 against y = 420 in the tiles that have a unit, because the 18 px unit span grows the value's line box. At 390 the arrow centres on two-line deltas instead of sitting on the first line. Pack overview.
Fix:
- `.jy-stat .value { display: flex; align-items: baseline; height: 48px; }`
- `.jy-stat .unit { line-height: 1; }`
- `.jy-stat .delta { align-items: flex-start; } .jy-stat .delta svg { margin-top: 3px; }`
- Unit spacing is `margin-left: 2px`, which glues "51s/q" together. The standard wants a space: use `margin-left: 0.25em`.
- At ≤ 480 px drop panel padding to 16 px (`.kpis .jy-panel { padding: var(--space-4) }`).

**18. A disabled primary or accent button keeps its orange cap or fill at 45 % opacity.** "Review import" (grey body plus orange cap), "Copy prompt" (pale salmon with low-contrast ink, about 2:1).
A disabled control should not be the view's orange point.
Fix: `.jy-btn--primary:disabled::before { display: none } .jy-btn--accent:disabled { background: var(--surface-sunken); border-color: var(--line); color: var(--ink-subtle); opacity: 1; }`.

**19. Hover lifts are not gated to hover-capable pointers, so on touch a tapped card or button stays lifted with the hard shadow until the next tap.** Every `.jy-panel--link`, `.jy-btn--primary`, `.jy-btn--accent`.
Fix (`app.css` lines 82, 96–97): wrap the `:hover` rules in `@media (hover: hover) and (pointer: fine) { … }`, keeping `:focus-visible` outside. Also follow the standard's exit rule: `.jy-panel--link::before` uses the 640 ms ease-out sweep in both directions. Add `transition: transform calc(var(--dur-sweep) * 0.6) var(--ease-in)` on the non-hover state and keep ease-out for the hover state.

**20. A recorded time can exceed the paper cap.** Results after auto-submit read "1:15:25 time" on a 75-minute paper. That happens whenever the tab was asleep across zero, which Decision 33 deliberately charges.
Fix: clamp the displayed and stored `timeMs` to `capMin * 60 000` at submit (`src/lib/engine/session.ts`), or label it "75:00 (cap)".

### Minor

**21. Start dialog jumps 55 px vertically when you switch the timer option**, because the modal is centred and its height changes. Fix: `.backdrop { place-items: start center; padding-top: max(var(--space-4), 8vh); }`.

**22. Start dialog: "No limit" contradicts its own help text** ("Counts down from the 75-minute cap… Total 1:15:00"). Rename the option to "Cap only" or "Full time (75 min)".

**23. Start dialog: the Seconds/Minutes field is misaligned with its slider** (slider centre y = 492, input centre y = 507). Fix: `.row` with `align-items: end` in `src/screens/start.tsx`, or put the label left of the input.

**24. Start dialog: the Strict checkbox shrinks to about 13 px when its label wraps** (390 and 1440), against 18 px for Shuffle, and centres on a three-line label. Fix: `input[type=checkbox], input[type=radio] { flex: none; }` and `.check { align-items: flex-start } .check input { margin-top: 3px }`.

**25. Start dialog footer mixes heights: Cancel is 44 px, Start (lg) is 52 px.** Use the same size for both buttons in a modal footer. Same in the prompt dialog.

**26. Text under the 12 px minimum:** `.kbd` 11 px (app.css line 336); chart tick labels and bar values 11 px (`src/ui/charts.tsx` lines 111, 117, 177, 219, 285); paper-card ring text 11.4 px. Raise all of them to 12 px.

**27. Off-scale sizes:** 14 px is used for crumbs, secnav, tabs, `.jy-table`, `.chart-sentence` and toast (only the button token is 14). Move text to 13 (small) or 15 (body). `.qtext` uses line-height 1.55 and `.opt .ot` 1.45; set fixed 28 px and 24 px so they sit on the 4 px grid. Inline `fontSize: '22px'` in library.tsx:118 should use a token (see #14).

**28. Fractions in question text open up uneven line spacing** (Q1: line 1 to line 2 is 46 px, other lines 31 px). Fix: `.mk-frac { line-height: 1.1; font-size: 0.8em; vertical-align: -0.45em; }`.

**29. More than two radii in one view.** 10 px (panels, buttons), 7 px (`.seg button`, `.opt .l`, `.qgrid button`), 4 px (`.kbd`), 2 px (neutral badge) and 50 % / pill. The standard allows at most two per view. Use 10 px outside; inner elements 6 px (= 10 − 4 px inset) via a single `--radius-inner` token; drop the 4 px and 2 px radii.

**30. Off-grid spacing:** 6 px gaps (`.jy-field`, `.jy-badge`, `.qgrid`, `.chip`) and 3 px seg padding. Use 4 or 8 px. With 8 px, `.qgrid` is still 5 × 44 + 4 × 8 = 252 px, which fits the 264 px rail.

**31. The question grid legend uses a literal "12" as the answered swatch and ▶ glyphs for flag.** The flag shape in the cells is a pennant, and Decision 10 says Flag uses a flag shape. In the question header, the "Flagged" badge is `jy-badge--ink`, which renders a *circle*. Fix: legend swatch = an empty 12 px square with the answered fill; give `.jy-badge--ink::before` the same pennant `clip-path` as `.qgrid .fl`.

**32. The low-time clock is colour-only.** The bar adds stripes (good), but the clock just turns red. Add a "Low" word or the diamond before the clock under 10 %, to meet the shape + word + colour rule.

**33. The timer bar drains from the left** (`transform-origin: right`), so remaining time sits at the right edge, opposite to the reading direction. Use `transform-origin: left`. Keep the pace marker logic.

**34. Mobile top bar: the 40 px lockup (about 170 px wide) dominates, and the settings gear floats in the middle.** Order is DMC · spacer · gear · signature. At ≤ 640 px put the gear last, after the signature, so the brand pair reads as a block. Also the signature button has 4 px padding, so the lockup sits 3–5 px inside the page gutter in the top bar and footer: set `.signature { padding: 0 }` and keep the 44 px hit area with `min-width`.

**35. Settings content is centred** (starts at x = 305 at 1440 while the top bar starts at x = 144). The standard says left-aligned and asymmetric. Left-align the settings column to the page gutter, max width 760 px.

**36. Paper browser: chips are 36 px next to a 44 px search input and a 44 px select.** That makes one ragged row on desktop. At 390 the sort select sits alone on its own row. Fix: chips 44 px everywhere (`.chip { min-height: var(--hit-min) }`), and label the select ("Sort: Title").

**37. Paper browser: card meta wraps inconsistently** ("2 days ago" drops to its own line on one card but not its neighbour), so card heights and badge positions differ. Put recency on a fixed second meta row in every card. Nested groups indent 16 px per level, which wastes width at 390: indent only the header, not `.group-body`.

**38. Insights duplicates the overview trend chart directly below it, and its underline tabs sit under the underline section nav** (two identical nav idioms stacked). Make the Insights tabs a `.seg`, or drop the Trend tab, since the overview already has the trend.

**39. Activity heatmap squares are about 10 px with no weekday or month labels.** They occupy 250 px of a 560 px panel; at 390 they are cramped. Fix: size cells to fill the panel width (`width = (panelWidth - labels) / 18`), and add Mon / Wed / Fri and month labels (12 px).

**40. Recent sessions table at 390 wraps dates ("2026-\n10-29") and titles to three lines.** Fix: `white-space: nowrap` on the date column; hide S/Q under 480 px.

**41. Empty "locked" states draw a dashed box inside a solid panel** (Trend, Verdict, Pace by thirds, Speed vs score on a new pack), a double frame. Drop the dashed border inside panels; keep it only for stand-alone empty areas (papers list).

**42. Rushed panel: question chips are underlined links inside bordered pills** (double affordance), 17 of them in two ragged rows. "10.0 Q" is an odd unit. Fix: plain underlined inline list ("Q23–Q39, 12 s each; Q40, 13 s") or a compact table, and write "10 questions (25 points) below median".

**43. Results hero ring is 168 px**; at 390 it sits alone above the title and pushes the score below the fold. At ≤ 640 px use 96 px, inline left of the title. The stat row also wraps unevenly at 390 (score alone, then accuracy + time); stack the stats as a 2 × 2 grid.

**44. The figure well blows a 240 × 100 SVG up to the full card width (about 1 000 px).** The strokes become 8 px and the image is about 380 px tall. In dark it is a large bright block. Fix: `.fig img { max-width: min(100%, 640px); }`.

**45. Library add-card is orphaned on its own row at 1440 with 3 packs**, and its three lines spread across 208 px. Fix: `.add-card { align-content: center; min-height: 0; }`. Once packs exist, consider moving "Add pack" into the hero next to "Make a pack with AI" as a secondary button.

**46. "Back up everything" is an h3 floating between panels** in Pack > Data, while siblings are titled inside their panels. Put it inside one panel with the three options as rows, or make it an h2-level subsection head with the same 16 px margin as `.section-head`.

**47. Copy:** "Reported questions: None. … ▲ Needs figure May/June …" contradicts itself; say "No reports. 9 questions need a figure: …". Hero onboarding "Practise like it is the real paper." should read "Practise like it's the real paper." (natural voice, sentence case is fine).

**48. Modals have enter motion (rise 240 ms) but no exit; they unmount instantly.** The standard wants exits with ease-in at 60 % duration (≈ 144 ms fade). Option selection has no tactile response: `.opt` transitions `transform` but nothing ever changes it. Add `.opt:active { transform: translate(1px, 1px) }`, as `.jy-btn` already does.

**49. Two orange caps on the question screen** (the selected option's cap and Next's primary cap). Decision 11 makes the selected answer the orange point. On the session screen, render Next as `--primary` without the cap (`.qs-ctrl .jy-btn--primary::before { display: none }`).

**50. Onboarding at 390: the two hero buttons have different widths** (238 / 205 px). At ≤ 640 px make them `--block`. At 1440 the onboarding leaves the lower 40 % of the viewport empty above a footer that floats mid-screen. Pin the footer with `main { min-height: calc(100dvh - var(--top-h) - footer) }`, or `body { display: flex; flex-direction: column }` with `main { flex: 1 }`.

## What is already at 9+ (no action)

Token use (no raw colours in CSS or TSX apart from the meta `theme-color`), font families and weights (no 600 anywhere), focus ring, toggle (the only pill), reduced-motion handling, the end-session and resume modals' copy and button order, 300-paper browsing (year groups collapse, `content-visibility` keeps it fast), and the brand variant switching between light and dark grounds.
