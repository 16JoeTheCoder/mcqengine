# v2 fresh-eyes review

Date: 2026-10-25. Method: the production build with the in-browser mock backend, driven by Playwright through first run, import, an exam session, results, home, sign-in, posting and the Library, captured at 1440 px and 390 px in light and dark (28 screenshots), then read against DESIGN.md. Plus axe (WCAG 2.2 AA, serious and critical) on every v2 screen in both themes, and a read of the data paths for integrity.

## Design consistency

| # | Finding | Severity | Outcome |
| --- | --- | --- | --- |
| 1 | Default Library cover: a 12-character title ("Physics 9702") ran past the Tab's right edge; the subtitle repeated the title. | Medium | Fixed: the font size fits the longest line inside the Tab; the subtitle is dropped when it equals the title. |
| 2 | Star toggle on set cards was nearly invisible: a CSS clip-path cut the outline away. | High (the rating control) | Fixed: a 2 px stroke star icon, filled when starred, with the count beside it. |
| 3 | Detected facts in the post dialog used the blue "ok" badge, which reads as a status. | Low | Fixed: neutral ink badges. |
| 4 | On phones the Library had no entry point (the top-bar link is hidden below 640 px). | High | Fixed: a "School Library" button under Daily 10 on the home screen. |
| 5 | Two dialogs shared the paper's title as their name (start, and key and details), confusing for screen readers. | Medium | Fixed: "<paper>: key and details". |
| 6 | The key grid used `aria-pressed` on radio buttons (axe: aria-allowed-attr). | Serious (axe) | Fixed: `aria-checked` only, styled the same. |
| 7 | One orange point per view: home (Make a pack, or Start Daily 10 when due), Library (Post a set), welcome (Sign in with school email), personal best (the panel's cap; Back to pack drops to plain). Primary buttons keep their orange cap, as in v1. | — | Holds. |
| 8 | Timer bar: ink at rest, OKLCH mix to warn and bad, stripes, pulse and "Low: N min left" in the last 10%. A full-width ink bar is heavier than v1's blue, as the brief asks. | — | Holds. |

## Usability

* First run leads with "Sign in with school email"; both other choices are one click and never block (tested).
* Posting from a pack on the device is three taps: Post a set, choose the pack, Post. Validation happens before upload; cancel and resume are tested, including across a reload.
* A personal account sees the Library locked with one line on how to unlock it (tested).
* Results without a key say so and offer "Add the key" with the student's answers pre-filled ("Mark it myself").

## Data integrity

* Regrading rebuilds stats by replay; a test proves the replay equals the incremental updates.
* Sync never overwrites a local open session, tracks per-record versions so restored backups still sync, and survives cut pushes and pulls (tested).
* Library packs carry `origin`, cannot be exported as files, and are labelled private in backups (tested).

## Not verified here

* Real Supabase: Google OAuth redirect, email links, signed-URL downloads and XHR upload progress against the live Storage API. The SQL is verified in PGlite; the client paths ran only against the mock.
* Real exam PDFs (only synthetic PDFs are used, by policy) and scanned PDFs, where the mark-scheme reader and cross-check correctly do nothing.
* Printing the notebook on paper (the print stylesheet was checked by reading, not on a printer).
* iOS Safari and Firefox (tests run on Chromium only).
