# DMC design review, round 3 (final)

**Build:** branch `ccr-7d4756bd-86dw39` at `ac0bc33` ("Fix review round 2 and logic audit round 3 findings"). Fresh `npm run build` and `vite preview --port 4174`, with a new profile: 3-paper, 300-paper and zip packs, 5 baseline exam sessions plus one rushed session.

**Coverage:** 390, 820, 1440 and 2560 in light; 390 and 1440 in dark. At 2560 I clicked with `evaluate(e => e.click())`. The DOM overflow pass found nothing at any width. Screenshots and scripts are in `/tmp/claude-0/-home-user-mcqengine/701b595c-11bd-5b61-bab0-60ab67bedf0d/scratchpad/design/` (`shots3/`, `cap2.mjs`, `f.mjs`, `n.mjs`).

**Verdict:** round 2 is almost fully addressed. Of 22 findings, 16 are fixed, 5 are partly fixed and 1 is accepted by decision. However, the R21 fix introduced a **Critical regression: every figure renders at 0 × 0 px.** This covers inline-SVG figures and figure files, on the question screen and in the import-review preview, at every width and in both themes. Questions that say "as shown" cannot be answered. This must be fixed before shipping. Everything else left is polish.

## Decisions 92–100

| Decision | Judgement |
| --- | --- |
| 98, Insights "Trend" renamed "History", tabs use the segmented control | Accepted. This closes the duplicate chart and the stacked underline navs. At 390 the segmented control wraps "Calibration" onto a second row (N4). |
| 99, timer colour bands, "Low" visible on phones | Accepted and verified at 390 / 1440 / 2560. |
| 100, no heatmap month labels; error list count announced only | Accepted, with one caveat. The heatmap is still unlabelled and leaves a ~180 px void in its panel at 1440 (N6). That is a layout point, not a labelling one. |
| 92–97 | Logic and data rules, with no design objection. 97 verified: the time-cap note shows in import review. |

## Status of R1–R22

| # | Round-2 finding | Status | Evidence / remainder |
| --- | --- | --- | --- |
| R1 | Prompt dialog sticky bar | **Partly** | At 390 the bar now sticks to the modal bottom and nothing overlaps. At 1440 the actions are plain buttons at the end of the left column: `Copy prompt` sits at y = 1215 in a 900 px viewport, so the main action is invisible when the dialog opens, and the right column is a blank strip below the preview (N2). |
| R2 | Image-only question at 390 | **Fixed (layout)** | The image now fills the card width (300 px). A 600 px scan is therefore drawn at 50 %, so body text is about 10 px. The remaining fix is zoom (N5). |
| R3 | KPI baselines | **Fixed** | All four deltas sit at y = 411. Arrows top-align at 390. |
| R4 | Trend point outside axis | **Partly** | The 55 % point sits inside the plot now, but there is no gridline or tick below 60. The lowest point floats under the last labelled line (overview trend, all widths) (N3). |
| R5 | Library card grid | **Fixed** at ≥ 820 / **Partly** at 390 | Fixed rows ("Every paper done once", "Next: …", meta). At 390 the one-line meta runs into the card edge ("Not practised yet" touches the border), and "0/300" nearly touches the 64 px ring (N7). |
| R6 | Insights duplication | **Fixed** (Decision 98) | Heatmap void remains (N6). |
| R7 | Paper-card meta wrap | **Partly, new defect** | Meta is now `nowrap; overflow: hidden` with **no ellipsis**, so it clips mid-word ("2 days ag") on the 1440 paper card (N1). |
| R8 | "Low" on phones | **Fixed** | |
| R9 | Timer segmented control wraps | **Fixed** | "Full time / Total / Per question" fits at 390. |
| R10 | Reserved band, redundant copy | **Fixed** | Copy is still doubled ("The full time allowed for this paper, 75 minutes." + "Total 1:15:00") (N9). |
| R11 | Import review: Apply to all, badge | **Partly** | "Apply to all" is now sans, but still sits under the input, right-aligned. The status badge is still 10 px above the input midline (N8). |
| R12 | Next weight, option press | **Fixed** (Next is inverse) | On the last question, "Finish" goes back to an outline button, so the final action is the weakest one (N10). |
| R13 | 2560 header width | **Fixed** | |
| R14 | Grid ring clipped, cramped ring text | **Fixed** (grid) / **Partly** (ring text, see N7) | |
| R15 | Key hints on touch | Not verifiable (Playwright does not emulate a coarse pointer); CSS not checked this round. | |
| R16 | Strict checkbox alignment | **Fixed** | |
| R17 | Type and grid leftovers | **Partly** | Not re-measured in detail; nothing visibly off-scale in the shots. |
| R18 | Shell leftovers | **Partly, new defect** | The footer now pins to the bottom on short pages. But on Settings the last panel's border runs straight into the footer rule with zero gap (N11). Gear position at 390 unchanged. |
| R19 | Backup buttons, floating h3, sort label | **Partly** | Export buttons align and have specific labels. "Back up everything" is still a heading between panels; the sort select still reads only "Title". |
| R20 | Results details | **Fixed** | The "10 Q" caption still says "questions, 25.0 points…", so "Q … questions" is redundant (N12). |
| R21 | Dark figure well | **Regressed → Critical** | See N0. |
| R22 | 820 grid sheet | **Fixed** | The grid is centred, but its legend stays left-aligned under it (N13). |

## Scores, round 3 (round 2 in brackets)

| Screen | Hier. | Spacing | Align | Type | Colour | Consist. | Motion | Empty | Polish | Worst |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Library, empty | 9 (8) | 8 (8) | 9 (8) | 9 (8) | 9 | 9 (8) | 9 | 8 | 9 (8) | |
| Library, with packs | 9 (8) | 8 (7) | 9 (7) | 9 (8) | 9 | 9 (7) | 9 | — | 8 (7) | 390: 8 |
| Pack: overview | 9 (8) | 8 (7) | 9 (7) | 9 (8) | 9 (8) | 9 (8) | 9 | 8 | 8 (7) | |
| Pack: start | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 | 9 (8) | 9 (8) | |
| Pack: papers (3) | 8 (7) | 8 (7) | 8 (7) | 8 (8) | 9 (8) | 8 (7) | 9 | 8 | 7 (7) | |
| Pack: papers (300) | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 | 8 | 8 (8) | |
| Pack: insights | 8 (6) | 7 (6) | 8 (7) | 9 (8) | 9 (8) | 9 (6) | 9 | 8 | 8 (6) | 390: 7 |
| Pack: data | 8 (7) | 8 (7) | 9 (7) | 9 (8) | 9 (8) | 8 (7) | 9 | 9 (8) | 8 (7) | |
| Prompt dialog | 8 (7) | 8 (7) | 8 (6) | 8 (8) | 9 (8) | 8 (7) | 9 | 8 (7) | 7 (6) | 390: 8 (5) |
| Import wizard, input | 9 (8) | 8 | 9 (8) | 9 (8) | 9 | 9 (8) | 9 | 8 | 9 (8) | |
| Import wizard, review | 8 | 8 (7) | 7 (7) | 8 (7) | 9 (8) | 8 (7) | 9 | — | **4** (7) | preview figures missing |
| Start dialog | 9 (8) | 9 (7) | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 | — | 8 (7) | 390: 9 (6) |
| Question screen, text/table | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 | 9 (8) | 9 (8) | — | 9 (8) | 390 / 2560: 9 |
| **Question screen, figure** | 9 | 9 | 9 | 9 | 9 | 9 | 9 | — | **2** | **all widths and themes** |
| Image-only question | 9 (8) | 8 | 9 (8) | 8 | 9 | 9 (8) | 9 | — | 8 (8) | 390: 6 (4) |
| Timer states | 9 | — | 9 (8) | 9 (8) | 9 | 9 (8) | 9 (8) | — | 9 (8) | |
| Practice feedback | 9 | 9 (8) | 9 (8) | 9 | 9 | 9 (8) | 9 (8) | — | 9 (8) | (figure question: see above) |
| End-session / resume | 9 | 9 (8) | 9 (8) | 9 (8) | 9 | 9 | 9 (8) | — | 9 | |
| Results | 9 (8) | 9 (8) | 9 (8) | 9 (8) | 9 | 9 (8) | 9 | — | 9 (8) | 390: 9 (7) |
| Rushed-error panel | 9 (8) | 9 (8) | 9 (8) | 8 | 9 | 8 | 9 | — | 8 | |
| Settings | 9 (8) | 8 | 9 (7) | 9 (8) | 9 | 9 (8) | 9 | — | 8 | |
| About | 9 | 9 (8) | 9 | 9 (8) | 9 | 9 | 9 (8) | — | 9 | 390: 9 |
| Dark theme overall | 9 (8) | — | — | — | 9 (8) | 9 (8) | — | — | 8 (8) | figures missing |

Every score below 9 maps to a defect below.

## Remaining defects, ordered by impact

### Critical

**N0. New regression: figures render at 0 × 0 px everywhere.** This affects the question screen (Q7 inline SVG; zip pack Q1 figure file) at 390 / 820 / 1440 / 2560 in light and dark, and the import-review preview. Measured with `f.mjs`: `img` boxes are `0x0` with `naturalWidth` 300 × 125. What renders is an empty 26 × 80 px paper pill.

The cause is the new `.paper.fig { width: fit-content; max-width: 100%; align-self: flex-start; }` (app.css line 449), combined with `.fig img { width: auto; max-width: min(100%, 560px); }`. A replaced element with a percentage max-width contributes 0 to its parent's min-content (fit-content) width, so the paper shrinks to its padding and the image collapses to 0.

Fix (`src/styles/app.css`):
```css
.paper.fig { width: auto; max-width: 100%; align-self: stretch; }
.paper.fig img { width: 100%; max-width: 560px; height: auto; }
```
To keep the R21 intent (no full-width bright block in dark), use `.paper.fig { width: min(100%, 584px); }`, an absolute cap that does not depend on the child.

Add an e2e assertion that every rendered `.fig img` has a non-zero bounding box. That would have caught this.

### Major

**N1. Paper-card meta clips mid-word with no ellipsis** ("2 days ag", Pack > Papers at 1440). Fix:
- `.paper-card .m.meta1 { text-overflow: ellipsis; }`.
- Better: move recency out of that row into the status row, so nothing is cut: drop "attempts" to "2×", or put "2 days ago" on its own line in every card.

**N2. Prompt dialog at ≥ 900 px: the main action is below the fold on open** (`Copy prompt` at y = 1215 / 900). Fix: use the same sticky bottom bar as at 390 at all widths (actions as a direct child of `.modal`, `position: sticky; bottom: -24px`). Alternatively, render a second Copy/Import row under the preview inside the right `.sticky-col`, which is visible on open and makes use of the empty column.

### Minor

**N3. The trend chart has no tick under the lowest point** (55 % below the 60 line). Fix (`src/ui/charts.tsx`): derive the ticks from the domain minimum, `for (t = yMin; t <= 100; t += step)`, with `yMin = floor(min / 10) * 10` (50 here), so a 50 gridline is drawn.

**N4. The Insights segmented control wraps at 390** ("Calibration" on a second row inside the bordered control). Fix: at ≤ 640 px use `overflow-x: auto; flex-wrap: nowrap` on that `.seg` (a scrollable segmented strip), or shorten the label to "Confidence".

**N5. Image-only scans are drawn at ~50 % on phones** (text about 10 px).
- Add tap-to-zoom: open the image full-screen with pinch enabled, e.g. a `<dialog>` holding the `<img>` at natural size inside `overflow: auto`.
- Trim the paper well's padding at ≤ 640 px (`.qimage.paper { padding: 4px }`) to gain about 16 px.

**N6. The Activity panel has a ~180 px empty band under the heatmap at 1440**, because it is stretched to the height of Recent sessions. Fix: `.grid-even { align-items: start }` for that row. Or put the summary sentence and a "sessions this month" figure under the heatmap. Labels stay out per Decision 100.

**N7. At 390, library-card meta and ring text touch their containers.** "Not practised yet" runs to the card border, and "0/300" fills the 64 px ring edge to edge. Fix:
- Allow the meta to wrap at ≤ 640 px (`.pack-card .meta { flex-wrap: wrap }`), or drop "Not practised yet" when "Next:" is shown.
- Ring text: when the label is longer than 3 characters, use `font-size: size * 0.18`.

**N8. Import review, desktop.** The status badge is 10 px above the input midline, and "Apply to all" sits under the input. Fix: wrap the badge in a 44 px flex box (`display: flex; align-items: center; min-height: 44px`). Put "Apply to all" inline to the right of the first row's input, or above the time-cap column header.

**N9. The start dialog repeats the time.** "Full time" help reads "The full time allowed for this paper, 75 minutes." followed by "Total 1:15:00". Delete the help sentence for Full time; keep only "Total 1:15:00".

**N10. "Finish" on the last question is an outline button, while "Next" is inverse.** Give Finish the same inverse style (it is the same slot and the same action weight).

**N11. Settings: the last panel's border touches the footer rule** (zero gap), a side effect of the flex footer. Fix: `main { padding-bottom: var(--space-9) }`, or keep `.footer { margin-top: var(--space-9) }` alongside `flex: 1` on main.

**N12. Rushed panel: the caption repeats the unit** ("10 Q" / "questions, 25.0 points below your median"). Use the caption "25 points below your median" (integer points, matching "10 Q"). The line also wraps, which makes this column taller than its neighbours.

**N13. 820 grid sheet: the grid is centred but the legend is left-aligned.** Centre the legend too (`justify-items: center`), or left-align both.

**N14. Carry-overs, low impact** (from R18 / R19):
- The gear still floats mid-bar at 390; set `order` so it sits after the signature.
- "Back up everything" is still an h3 between panels.
- The sort select still reads only "Title" (render "Sort: Title").

### Observation (not scored)

With a copied browser profile that already has the service worker registered, the first page load reloads itself once, about 2.9 s after opening. Seen on Results at 390 and 1440 (`n.mjs`: two main-frame navigations; a fresh profile shows one). In those runs the screenshot caught a blank page mid-reload. `main.tsx` only reloads after an accepted update, so the trigger is unclear, and it may be an artefact of copying the profile. It is worth checking manually: close a tab right after the first visit, then reopen it.

## Summary

- **Critical (1):** N0, missing figures. A one-rule CSS fix, but it blocks release.
- **Major (2):** N1 clipped paper-card meta, N2 prompt dialog CTA below the fold on desktop.
- **Minor (12):** N3–N14.
- **At 9 or above:** start, timer, practice feedback, end-session and resume, results, About, question screen layout at all widths, 300-paper browsing, the empty library, and dark-theme colour.
