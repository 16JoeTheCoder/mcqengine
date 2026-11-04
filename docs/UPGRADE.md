# Revision-tool upgrade

This document describes implemented source changes. No public deployment, production SQL, authentication setting, DNS record or production data was changed.

## Implemented

- Email-code request, verification, invalid/expired-code errors, resend cooldown, change-email and sign-out. Supabase remains the backend; school Library permissions remain server enforced. Guests can practise offline.
- Separate IndexedDB workspaces for every account and guests. Account changes immediately invalidate sync and restart the document, discarding old screen/import closures. Sync requests capture the expected account's bearer. Guest adoption explicitly copies validated records and assets, retains originals and rebuilds derived statistics.
- Shared-device removal exports a complete backup, refuses open sessions, requires successful sync with no pending records or unacknowledged conflicts, then removes that account's cache and signs out.
- Cloudflare Pages frontend, same-origin `/api/*` Worker route, production/preview/development examples, private NVIDIA secret and CSP/cache headers. No Agents or Workflows.
- Board mode: approximately 50/50 question and completely empty writing space. The right half has no children, text, annotation controls or handlers; pointer events pass through it. Includes fullscreen, independent question scrolling, light/dark/system theme, persisted text size, deliberate answer then explanation reveal, jump, elimination and revisit controls in the question half. Narrow screens return to regular practice. External whiteboard annotations remain outside the app's control.
- AI PDF import through the authenticated Worker: selected pages, local text extraction and bounded rendered page images, explicit transfer consent, progress/cancellation/retry, account-local batch recovery, source crops, editable quality review, and existing validation/conflict/import machinery. Answers stay unkeyed without a supplied mark scheme. Browser and Worker share protocol types, bounds and output validation.
- A persistent named Durable Object coordinates the shared NVIDIA budget (30 RPM default, configurable below 40), per-account daily requests and concurrent calls. Failed calls/retries count against the budget. The provider endpoint is fixed; no provider key reaches the browser.
- Deletions and dependent tombstones propagate across devices. Removing downloaded content is a separate action that preserves progress. Explicit recreation clears tombstones transactionally. CAS writes reject stale bases as an atomic batch; server revision cursors handle tied timestamps and device-clock skew. Split session summary/detail revisions stage across pages and restarts until complete. Statistics derive from complete attempts instead of syncing independently.
- Transactional session revision tracking avoids routine full-history scans and answer-detail reads. Bulk restore/import/remote writes invalidate the small index once. Statistics rebuild once per affected pack per applied page, inside a consistent transaction. Heavy browser ZIP compression runs in a dedicated Worker.
- Backups include only assets referenced by included papers, fixes, snippets or historical question snapshots. Library exclusions apply to exclusive assets too. Resource bounds cover data, archive entries, decompression, asset sizes and storage. New sessions preserve question content; key changes preserve bounded regrade history. Old sessions remain readable with an explicit current-content fallback.
- Daily 10 creation, scheduling and navigation are removed. Historical `daily` records and old fields remain readable through restore/sync/stats replay.
- Results explicitly describe self-reported practice. Trend descriptions show sample sizes without assessment-verification or topic-mastery claims.

## Compatibility and recovery

Back up the old installation before upgrading. Apply `supabase/schema.sql` for a new project; for an existing installation apply `supabase/migrations/20261102_sync_boundaries.sql` after review. The additive migration retains existing sync rows, adds deterministic revision cursors and restricts direct writes. It is tested when reapplied. Older clients cannot use the new CAS contract; update devices together. Existing timestamp cursors restart once under the new revision RPC.

The original local database `dmc` is preserved and quarantined. Its missing ownership marker cannot prove that it was guest data. Nothing from it is automatically shown in the new guest workspace or uploaded. Use **Settings → Data → Recover previous-version data** or the Account menu and explicitly confirm ownership. A cache marked with another account ID is refused. Unmarked legacy caches require the user's ownership confirmation. Recovery copies records; it never deletes the original cache. Settings and old sync metadata do not cross workspaces. Existing account records win collisions.

For conflicting synced edits, the server version becomes active and the local copy is retained under the account's conflict records. The Account menu offers **Export and acknowledge conflicts**. Review and retain that export before acknowledging. This deliberately uses a small explicit recovery path rather than a complex merge interface. Full backups and cloud pack backups are separate from this conflict export.

**Remove content from this device** removes local paper files and sweeps unreferenced assets, retaining outlines and history. **Delete pack everywhere** queues synced deletion, including dependent records; offline devices receive it after reconnecting. Erasing the current local workspace does not delete cloud data, and synced progress can return. Historical snapshot assets may remain because reviews still reference them.

## Setup remaining

Follow [Cloudflare, SMTP, email codes, domains and NVIDIA setup](CLOUDFLARE_SETUP.md) and [Supabase setup](SUPABASE_SETUP.md). Fill placeholder public values, configure separate projects/environments, review/apply SQL, set email templates and custom SMTP, set the Worker secret and binding, associate custom domains and routes, verify DNS/HTTPS, then run the optional staging smoke test. These external actions require the owner's explicit authorization.

No credentials were supplied. Real SMTP delivery, live Supabase auth/storage behavior, deployed Durable Object behavior, DNS/HTTPS and live NVIDIA extraction were not exercised. Model request format was checked against an official NVIDIA example; current availability and account entitlement still need the documented live smoke test. Normal automated tests consume no NVIDIA quota.

## Limits and costs

AI imports select up to 20 question pages and up to three relevant mark-scheme pages per page batch. Larger papers can be imported in further chunks. Duplicate page-spanning questions are flagged and require manual merging in editable review. Crops can be inaccurate, and mathematical notation, tables and answer-key matches need human review. Full PDFs are kept locally by default, not stored by the API.

Full pack content and PDF/image assets do not sync automatically. Finished-session content snapshots do sync for historical review; these are bounded by the per-record and account payload quotas. A second device needs an import/Library download or an optional pack backup to practise full papers or view missing assets. Progress-only backups do not include image/PDF bytes. Old sessions cannot retroactively recover content that was never saved. Regrade history retains the latest 100 correction events per session.

The account sync boundary allows 50,000 records and 64 MB of JSON payload; batches are bounded to 4 MB, individual records to 262,144 bytes. Very image-heavy text snapshots can hit the record bound: local data remains intact and sync reports failure instead of a false success. Use a full backup and reduce unusually large typed content before retrying.

Backups are bounded to 15 MB JSON data, 100,000 rows, 2,000 entries, 5 MB per image, 60 MB per PDF, 300 MB uncompressed and 100 MB compressed. The browser archive worker has a 120-second timeout. Cloud backup storage also has database-enforced file-count/byte limits. Export smaller sets if a bound is reached.

Hosting costs come from Workers/Durable Object requests, storage and active time, Supabase database/storage/auth, SMTP and NVIDIA inference/credits. The stated 40 RPM is throughput, not free usage. The default shared cap leaves headroom, but every application using the same provider allowance must share coordination. Preview and production must not independently spend the same key's allowance; use separate keys/allowances or a single coordinator. See the setup guide for exact variables and monitoring.

Chromium is covered by browser tests. Safari/Firefox, physical whiteboard software, printing and real classroom distances still require device checks. Existing design tokens, typography and components are preserved; no replacement design system was introduced. Board controls use the same primitives and themes. The blank light background is deliberately plain white.

## Verification

From a terminal in the repository root:

```sh
npm run check
npx playwright install chromium
npm run e2e
npx wrangler deploy --dry-run --outdir /tmp/mcq-worker-dry-run
```

`npm run check` includes strict frontend and Worker typechecking, lint, unit tests (including PGlite SQL enforcement) and a production build. CI runs those checks and Chromium browser regressions. Mocked provider responses cover key secrecy, shared limits, quotas, retry, cancellation, failed-batch recovery and review. The browser suite covers account A → guest → B → A, explicit guest adoption, email codes, shared-device cache removal, board blank space, keyboard access, themes, narrow fallback, original practice flows, offline behavior and backups. Final local results are recorded in `PROGRESS.md`.

Future work is optional rather than implemented: additional browser/device coverage, a graphical conflict merge UI, and extraction-quality tuning against synthetic representative papers. No LMS features are planned by this upgrade.
