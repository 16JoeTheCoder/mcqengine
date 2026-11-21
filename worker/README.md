# The DMC Worker

One Cloudflare Worker serves the built app (static assets) and every `/api/*` route. Each route checks auth and membership itself; the app never decides access. Modules: `auth.ts` (Google OAuth + PKCE, sessions, membership), `library.ts` (sets, versions, paper registry, stars, reports), `blobs.ts` (content-addressed files in R2), `sync.ts` (compare-and-set sync), `ai.ts` (prompt registry, the `AiBudget` Durable Object queue), `admin.ts`, `backup.ts` (nightly D1 dump and file collection, run by the cron), `index.ts` (router, health, client errors, personal backups).

Tests run this Worker in workerd through Miniflare: `npx vitest run tests/unit/worker-` from the repository root, in the VS Code terminal. Deploying: [setup.md](../setup.md).
