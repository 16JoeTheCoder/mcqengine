# Phase 2 decisions

One line each, with the reason. Made during the Phase 2 build; the long-term list is [docs/DECISIONS.md](docs/DECISIONS.md), where the lasting ones are copied at the end.

## Identity (the unlinking bug)

- Root cause 1: packs had no permanent identity. The pack format carried only title and subject, so exporting a pack and importing the file again made a second pack with a new random id. Fix: `pack.setId` (UUID) in every pack, every export and every Library download.
- Root cause 2: posting gave the set a fresh random UUID and never linked the poster's own pack, and downloading always created `lib-<set id>`. Posting and downloading on one device therefore left two packs; posting again made a second Library set. Fix: the set ID *is* the pack's `setId`; download and import look a pack up by set ID, never by title.
- Root cause 3: papers matched by the id an AI wrote (`9702-s24-12`, `phys-may-june-2024-p12`, …), so one Cambridge paper became two. Fix: canonical keys worked out from file names or cover text (`shared/paper-key.ts`); the AI id is only a suggestion the user confirms.
- Regression tests: `tests/unit/unlinking.test.ts` (all three failed on the old code, see log.md).
- Existing pack ids are kept (sessions and sync rows point at them); `setId` is a new field and legacy packs get one on first export or post. Legacy `lib-<id>` downloads count as set `<id>` (`setIdOf`).
- A resolved paper takes its key as its id, so new question IDs read `9702_s24_qp_12#7`; a paper already stored under that key keeps its old id so its history stays linked.
- The validator keeps canonical keys' underscores; every other id is still slugified as before.
- Edited questions (same key, different hash) are a choice, "keep mine" or "use the Library's" (`prefer` in mergeDoc), instead of always blocking; leaving it unset keeps the old conflict behaviour for manual imports.
- The 53-bit content hash stays: it detects edits, it is not a security boundary.

## Cloudflare

- The Cloudflare tools attached to this build session point at a different account; nothing was created there. Every Cloudflare step is in setup.md for an agent with the council account token.
- D1 Time Travel: checked in Cloudflare's docs (D1 limits page, Nov 2026): available on every plan, 30 days on Workers Paid and 7 days on Workers Free, no extra cost. The council account's plan is not visible from here, so setup.md runs `wrangler d1 time-travel info` to confirm it is on. It is the second safety net; the nightly R2 dump is the first.
- Plan check (owner to confirm): `josef.yang@stjbs.sch.id` is seeded as the first admin from the brief's example; setup.md step 5 says to change it before migrating if the real address differs.

## Architecture

- One Worker for app and API (`run_worker_first = ["/api/*"]`): the static app never runs Worker code, so it stays as cheap and fast as Pages, with one deploy and one origin (cookies stay first-party).
- No new dependency. The Worker uses only the runtime (WebCrypto, DigestStream, FixedLengthStream, CompressionStream); the small binding types are written out in `worker/types.ts` instead of adding @cloudflare/workers-types. Tests use Miniflare, which already ships with Wrangler.
- Supabase-js and PGlite are removed (decreases the dependency count); their RLS tests are replaced by Worker route tests that run the real Worker in workerd with real D1, R2 and the Durable Object.
- D1 has no interactive transactions, so every multi-row rule is one `batch()` (atomic). Compare-and-set inside a batch: a guard row into `cas_guard` (CHECK ok = 1) for publishes, and `updated_at = CASE WHEN … THEN … END` (NOT NULL) for sync; a stale base fails the statement and rolls back the whole batch.
- Sync revisions come from a `counters` row bumped in the same batch; D1 serialises writes, so a later commit can never appear behind a pulled cursor (the reason the Postgres version needed an advisory lock).
- Membership: school = email domain in `library_domains` AND Google's `hd` claim equals it (a personal Google account that merely uses the address is not a member); allowlist and admins are members too. Admins no longer need to also be on the domain or allowlist, so an admin can be a teacher's personal address.
- Sessions: 30 days idle (rolled at most hourly, to save D1 writes), 90 days absolute. Only SHA-256 of the token is stored. The OAuth state, nonce and PKCE verifier travel in a short-lived HMAC-signed `__Host-` cookie, so starting a sign-in writes nothing to D1.
- CSRF: SameSite=Lax cookies, plus every non-GET request needs `X-DMC: 1` (a cross-site form cannot set it) and a same-origin `Origin`.
- Google accounts migrated from Supabase are linked by email on first sign-in when they have no Google subject yet; a different Google subject arriving with a recycled address releases the old row's email instead of taking over its data.
- Email-code sign-in is removed (Google only, as the brief says). Development and tests sign in through `POST /api/auth/dev`, refused unless ENVIRONMENT is `local` and the host is localhost.
- Files: R2 checks the upload's SHA-256 itself (`put(..., { sha256 })`), so mismatched bytes are never stored; the Worker also hashes the stream (DigestStream) and checks magic bytes in the first 512 bytes before anything is accepted.
- Blob reads need membership and a reason: the file is in a set the caller may see, or they uploaded it, or they are an admin. Unpublished uploads are therefore private to the uploader.
- Publishing may reference any file already stored (that is the dedupe); knowing a hash means having had the file, so this grants no new access in practice.
- Quota counts bytes new to the bucket against the first uploader only (300 MB members, 2 GB admins and allowlist). `blobs.size` is capped at 25 MB by a CHECK as well as in code.
- Two newest versions of a set are kept (the current one and the one before), so a copy on the previous version can still be inspected; older versions are pruned and their unreferenced files collected after 7 days.
- GC deletes the D1 row first (only if still unreferenced, `RETURNING hash`), then the R2 object, so a publish racing the cron either keeps the row or fails cleanly.
- The paper registry links a second set's paper to the first set's stored PDFs; the second poster's own copy is then not uploaded at all. Registry rows whose files are gone are dropped by the cron.
- Workers Rate Limiting bindings (uploads 120/min, publishes 20/min, client errors 10/min per key) instead of D1 counters: no writes, and limits that do not need to be exact.
- AI: queue (not reject) beyond 38 requests a minute in one Durable Object; the caller gets its queue position as NDJSON lines. Queue length is capped (60) and waits end after 10 minutes. The daily allowance counts user requests; the one repair call counts toward the per-minute cap but not the user's allowance.
- AI replies are checked twice: the task's own rules, then (for extraction) the app's pack validator on a synthetic paper. workerd does not implement `redirect: 'error'`; provider calls use `redirect: 'manual'` and treat a redirect as a failure (found by the Worker tests).
- The Worker cannot run the SVG sanitiser (no DOMParser). The figure task only rejects obviously unsafe SVG; the app sanitises every SVG on import, as before.
- Backups exclude `sessions` (tokens) and `cas_guard`. Restore is SQL generated by `scripts/restore-backup.mjs` and applied with `wrangler d1 execute --file`; long values are appended in 60 KB pieces to stay under D1's 100 KB statement limit.
- Personal pack backups (the old Supabase `backups` bucket) are kept as one zip per account at `user-backups/<id>/packs.zip`, at most 200 MB.
- Sync on/off is per device and per account in localStorage, not a synced setting (turning sync off must not need a sync to take effect).
- Practice mode is stored on the session detail (`view: 'pdf'`); old sessions without it are DMC mode. PDF mode never shuffles, because the printed paper has a fixed order.
- R2 buckets and D1 databases are created with the `apac` location hint (the school is in Indonesia).
- The admin seed and the school domain are a migration (`0002_seed.sql`); later changes happen in the admin panel.

## UX

- "Pack" becomes "paper set" in visible copy; code and storage names stay `pack` (renaming stored data would break sync and backups).
- Set cards keep Download and Star visible; Report, Restore and Delete move into a More menu; Delete asks in a dialog that says copies on devices stay.
- The make-a-set (AI prompt) dialog keeps subject, papers, title and mark schemes up front; folder path, counts, time, paper id, options, diagrams and splitting move under Advanced with the same defaults.
- A paper set with no finished sessions shows Start, Papers and Share only; the analytics appear after the first submitted session.
