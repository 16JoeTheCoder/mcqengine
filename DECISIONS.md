# Decisions

One line each: what was decided and why. Newest at the bottom.

1. The toolkit zip (PACK_FORMAT.md, schema, mcqpack.py, profile, make_fixture.py) was not in the repo or on the machine, so all of it was written from the build brief; drop the original files in and run `npm test`: the parity test will show any difference from `js/validator.js`.
2. The app lives in `mcq-engine/` inside the `16JoeTheCoder/16JoeTheCoder` profile repo so the profile README is untouched; set Netlify's base directory to `mcq-engine`, or move the folder to its own repo with `git subtree split -P mcq-engine`.
3. Spec choices made in the reconstruction: question type `"single"` is the only supported type; `rev` is a required integer; `options` must list every option key in `optionKeys` order; `fig` provenance is `crop` or `redraw`.
4. Validation errors carry a code; parity is checked on `(code, where)` pairs, not on message wording.
5. Overlays apply in a fixed order (listed in `pack.overlays`, then unlisted root `*.json` overlays by name); bad overlay contents are warnings, a missing listed overlay is an error.
6. Built-in packs are validated without asset checks in the browser (fetching every asset would be slow); `tests/importer.test.js` validates them fully, assets included.
7. Built-in packs only apply overlays listed in `pack.overlays`, because a static server cannot list a folder.
8. KaTeX 0.16.47 (the long-lived 0.16 line) rather than 0.17–0.19, and fflate 0.8.2; only woff2 fonts are vendored; `.mjs` renamed to `.js` for MIME safety.
9. Exam mode ends automatically when every question is answered unless a question is flagged; a flag means "I want to come back", so it holds the paper open.
10. Practice mode also ends automatically on the last answer, so its feedback is seen in the review list rather than on the question screen.
11. The timer counts `performance.now()` deltas only while the page is open; time with the tab closed is not counted after a resume. This is a known way to pause an exam.
12. Exam time limit scales with question count: `timeLimitSec / questions` per question, default 90 s per question, so a retry subset gets proportional time.
13. Unsupported question types are shown (as a placeholder) in their place but never scored or required for "all answered".
14. Mistakes are never deleted; "retry mistakes" includes every stored mistake of the pack, most-repeated first. Clicking the active cause tag again clears it.
15. Unreadable saved data is copied to `mcq:v1:backup` and a fresh record started, instead of silently overwriting or blocking the app.
16. Migration map `MIGRATIONS[n]` upgrades version n-1 to n; data without `v` counts as version 0.
17. Only sessions over the whole pack (not retry subsets) autosave for resume and are offered to the leaderboard.
18. Uploaded packs are stored as their raw files (pack.json text plus Blobs, overlays included) and re-validated on every open.
19. Zip entries over 50 MB and `__MACOSX/` entries are ignored when unzipping.
20. All pack text reaches the DOM through `setRich`/`setMath` in `js/text.js` (escape first, KaTeX `trust:false`); `innerHTML` appears nowhere else.
21. The CSP adds `object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'` to the requested policy; these only tighten it.
22. No service worker: "offline" means no third-party or network dependency beyond the site's own files; a deployed site still needs one online visit. A worker was left out to avoid stale-cache bugs.
23. `ALLOWED_PACKS` accepts `id` or `id:total`; with a total, the server can enforce "full-length run" itself.
24. The leaderboard reads a `best_scores` view (`DISTINCT ON`, `security_invoker = true`) so "best per client" is computed in the database, not by over-fetching.
25. `leaderboard.js` returns no client ids; nicknames are not unique.
26. Netlify functions use the Web `Request`/`Response` default export and `process.env`; there was no web access to re-check Netlify's docs during the build.
27. The extractor uses poppler (`pdftoppm`, `pdftotext -bbox`) and optionally Pillow to trim blank space under clips; no other Python dependencies.
28. The sample fixture writes units as `m/s` and `kg/m³` because the PDF base font lacks a superscript minus.
29. Snapshot questions are images, so screen-reader users get only the alt text "Question N as printed"; typed questions are the accessible path.
