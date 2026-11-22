# The DMC Worker

One Cloudflare Worker serves the built app (static assets) and every `/api/*` route. Each route checks auth and membership itself; the app never decides access. Modules: `auth.ts` (Google OAuth + PKCE, sessions, membership, suspension), `library.ts` (sets, versions, paper registry and matching, stars, reports), `blobs.ts` (content-addressed files in R2), `sync.ts` (compare-and-set sync), `profiles.ts` (profiles, avatars, reports), `search.ts` (D1 FTS5 search), `admin.ts` (dashboard, access lists, audit log), `backup.ts` (nightly D1 dump and file collection, run by the cron), `index.ts` (router, health, client errors, personal backups).

Routes (all under `/api`):

* Session: `GET /me`, sign-in and sign-out routes in `auth.ts`, `GET /health`, `POST /client-error`.
* Library: `GET /sets`, `POST /sets`, `PATCH /sets/<id>` (title, subject, description, status), versions, stars, reports, blob check and upload, `POST /papers/match` (look a paper up by file hash, text fingerprint or Cambridge code).
* Search: `GET /search?q=` (Library sets and profiles the caller may see).
* Profiles: `GET /profiles/<handle>`, `GET /profiles/<handle>/avatar`, `POST /profiles/<handle>/report`, `PATCH /me/profile`, `PUT` and `DELETE /me/avatar`.
* Sync and personal backups: see `sync.ts` and `index.ts`.
* Admin (admins only): `GET /admin/overview`, `GET /admin/users`, `POST /admin/users/<id>` (suspend, restore, sign out, quota, hide profile), `GET /admin/audit`, `GET /admin/duplicates`, `GET /admin/gc`, plus `storage`, `downloads`, `moderation`, `backups`, and `allowlist`, `admins`, `domains`.

There are no `/api/ai/*` routes; AI import was removed in Phase 3 and those paths return 404.

Tests run this Worker in workerd through Miniflare: `npx vitest run tests/unit/worker-` from the repository root, in the VS Code terminal. Deploying: [setup.md](../setup.md).
