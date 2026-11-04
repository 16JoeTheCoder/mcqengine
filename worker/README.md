# API boundary

`index.ts` is deployed as the separately routed Cloudflare Worker from root `wrangler.toml`. It has no frontend imports and no third-party runtime dependencies. One named `AiBudget` Durable Object per environment coordinates all provider calls; its storage transactions enforce rolling RPM, per-account UTC-day usage and expiring concurrency leases. Document contents stay in request memory only.

- `GET /api/ai/config`: verified Supabase bearer required. Returns public model/limits and configured status.
- `POST /api/ai/extract`: same auth. Accepts `{pages:[{page,role:'question'|'markscheme',text?,image?}],hasMarkScheme}` and returns `{questions,warnings}` after strict validation. `image` must be an inline PNG/JPEG data URL, never a PDF or remote URL. A legacy `kind` page-role alias is accepted.
- Every response is JSON with `Cache-Control: no-store, private`; errors contain safe messages only.

Run `npm run worker:typecheck` and `npx vitest run tests/unit/worker.test.ts` from the repository root terminal. See [deployment and operating guide](../docs/CLOUDFLARE_SETUP.md) for exact configuration, secrets and limits. Routine tests mock NVIDIA and consume no API quota. Live Cloudflare/NVIDIA smoke testing remains an explicit staging setup step.
