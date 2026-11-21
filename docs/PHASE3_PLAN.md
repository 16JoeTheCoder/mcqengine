# Phase 3 revision plan

Branch `phase-3` from `main`. One milestone per PR-sized commit set; `npm run check` before every commit. Order: remove first (less surface to test), then quick wins, then the bigger features.

## Rules for every milestone

* **Tests (strict, cheap):** pure logic gets unit tests (Vitest, ms each); every Worker rule gets a Miniflare route test for anonymous / non-member / member / owner / other / admin; one Playwright happy path per flow, plus axe (light and dark) on each new screen. No snapshot tests. A bug fix starts with a failing test.
* **Budget:** unit suite stays under 60 s and Playwright under 4 min. Test pure functions, not rendering; e2e only covers wiring between parts.
* **Subagents:** `claude-sonnet-5-5`, medium effort, only for tests from a written spec, fixtures, searching the code, docs and copy. Lead (Opus) writes product logic, schema, access rules, sync and design, and reviews every subagent diff before it is committed.

## M1. Remove AI import (and the AI stack)

Delete `src/screens/ai-import.tsx`, `src/lib/ai/`, `shared/prompts.ts`, `worker/ai.ts` (and the `AiBudget` Durable Object), the `aiRun` client methods (`backend/types.ts`, `cloudflare.ts`, `mock.ts`), the AI entry point in `import.tsx`, the AI card in `admin.tsx` and `settings.tsx`, the `NVIDIA_*` / `AI_*` vars, and the DO binding in `wrangler.toml`. Add a `deleted_classes` migration for `AiBudget`. Delete `tests/unit/ai-import.test.ts`, `worker-ai.test.ts` and `tests/e2e/ai-import.spec.ts`. Update setup.md (remove the NVIDIA secret), CLAUDE.md, README.md and PACK_BUILDER_GUIDE.md: "build the pack with your own AI using the guide".
*Test:* `/api/ai/*` returns 404; the import screen has no AI entry (included in the existing e2e).

## M2. Paper identity without typed keys

The user never types or confirms a key. Identity is found in this order:
1. **Exact file:** SHA-256 of the bytes, already used for R2 blobs, so identical files are already deduped.
2. **Same paper, different bytes** (re-saved or re-downloaded): a text fingerprint. Extract text from the first 3 pages with pdf.js, normalise it (lower case, digits kept, whitespace collapsed, the footer and the candidate box dropped), hash 8-word shingles and keep the 64 smallest as a MinHash. A Jaccard estimate of 0.9 or more counts as the same paper.
3. **Label only:** the Cambridge code read automatically from the cover (`9702/12/M/J/24`) and the PDF `/Info` and XMP title. These are used for display and as a hint, never as the identity.

Stored: `papers.fingerprint` (D1, a new migration) and a `fingerprint` per paper in the manifest. When posting, the Worker looks the fingerprint up and offers to "use the Library's copy" when it matches. Remove the key column from the post dialog and the import review. Existing keys stay readable as labels.
*Tests:* fingerprint unit tests on synthetic PDFs: the same text with different bytes matches, a different variant does not, and a scanned (text-free) PDF falls back to the hash only. Route test: lookup by fingerprint respects access.

## M3. PDF answering view

* **Follow** toggle (off by default, remembered per device): answering question *n* scrolls the answer sheet so *n+1* is centred. Only the PDF pane scrolls by hand. Respects reduced motion.
* Clicking the selected answer again clears it.
* A flag button per question.
* Submit warns about **unanswered** questions only, lists them and jumps to each one. Flagged questions that have an answer don't count as unanswered and get no warning; the flag just shows as a marker.

*Tests:* unit tests for `toggleAnswer` and `submitWarnings(answers, flags)`; one e2e that answers, re-clicks to clear, flags, and submits with one blank (warned) and one flagged answered question (not warned).

## M4. Practice feedback

In practice mode each question chip in the side list turns light green (correct) or light red (wrong) as soon as it is answered, with a running accuracy % at the top. The colours are tokens with a matching icon and word, so meaning never rests on colour alone. Exam mode is unchanged.
*Tests:* unit test for the `practiceTally` reducer; extend the PDF-mode e2e.

## M5. Edit a set's name and properties

Edit title, subject, description and cover from the home card (a More menu item) and from the set header. On a local copy, the edit changes the local set and keeps the `setId`. On a Library set you own, it also offers to update the Library listing (`updateSet`, which is already there). On a downloaded copy, it is a local rename only (a downloaded update keeps the local name).
*Tests:* unit test that a rename keeps `setId` and links on re-download; route test that only the owner or an admin can update.

## M6. Search everything

A search field in the top bar (`/` or Ctrl+K). **Local:** sets, papers, question text and notebook (an in-memory index built lazily from IndexedDB). **Server:** Library sets and profiles through `GET /api/search?q=`, backed by D1 FTS5. Every result is checked by the same access rule as its normal route. Results are grouped by type and work fully by keyboard.
*Tests:* route tests showing a non-member sees no Library results, a hidden or deleted set never appears, and private profiles are filtered out; one e2e.

## M7. Profiles

A profile page at `#/u/<handle>`: name, photo (R2, WebP, at most 512 px), bio (up to 160 characters), year or role, subjects, posted sets, stars received, and an optional stats card. Others can open it. Visibility is **school only** by default, can be set to private, and is never public on the web (`noindex`). The profile owner decides whether stats show. No messages and no follower feed in v1, because most users are school students under 18: a feed and direct messages need moderation staff this project doesn't have. Profiles can be reported into the admin queue.
*Tests:* route tests for each visibility × viewer pair; a handle-uniqueness test; axe on the profile page.

## M8. Admin dashboard

A full-height side panel opened from the account menu (admins only). The admin role is checked on the Worker for every request.
* **Overview:** users (total, active in 7 and 30 days), storage against 10 GB, uploads and downloads per day (14-day sparkline), client errors in 24 h, last backup, health.
* **Users:** search, role, suspend or restore, quota override, sessions (sign out everywhere).
* **Content:** reports queue, hidden sets and profiles, restore or delete, largest files.
* **Access:** domains, allowlist, admins.
* **Operations:** backups (run, list, restore steps), file collection (dry run), duplicate-paper report (from M2).
* An **audit log** (new D1 table) of every admin action.

*Tests:* route tests showing non-admins get 403 on every admin route, that suspension blocks a session immediately, and that each admin action writes an audit row; one e2e plus axe.

## Risks

* MinHash gives false positives on papers with very little text (short answer sheets), so we require 60 or more shingles or fall back to the hash only.
* FTS5 indexes need triggers kept in step with the tables. The migration test rebuilds them from scratch.
* Profiles of minors need sign-off from the school before release (data protection). Default visibility is school only.
