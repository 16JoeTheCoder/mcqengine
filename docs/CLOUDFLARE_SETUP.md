# Cloudflare, email codes and NVIDIA setup

DMC remains a static Preact/Vite PWA with Supabase Auth, Postgres and private Storage. Cloudflare Pages hosts `dist/`. A small, separately deployed Worker owns `/api/*`; one SQLite-backed Durable Object coordinates the NVIDIA account budget across Worker instances. There are no Agents, Workflows, classroom rosters or LMS services. Nothing in this change deploys publicly or changes an existing Supabase project.

## Local development

Use Node 22 or newer. In an Ubuntu/WSL or VS Code terminal, from the repository root:

```sh
npm ci
cp .env.example .env.local
cp .dev.vars.example .dev.vars
npm run dev
```

Replace `.env.local` placeholders before starting. For the local mock, omit that file or leave both Supabase values unset. The frontend is at `http://localhost:5173`. Without public Supabase values it uses the development mock. Manual imports and guest practice work without any server. AI import requires a real, email-verified Supabase session; mock tokens are deliberately rejected by the Worker.

Edit `.env.local` with the development project's **public** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. Edit `.dev.vars` with that project's `SUPABASE_URL`, public `SUPABASE_ANON_KEY`, `APP_ORIGIN=http://localhost:5173`, and private `NVIDIA_API_KEY`. Neither file is committed. The Worker uses the public Supabase key only to verify the supplied bearer at `/auth/v1/user`; it does not need a service-role key.

In a second terminal in the same repository root:

```sh
npx wrangler dev --env development
```

Wrangler serves port 8787 with local Durable Object persistence; Vite proxies `/api` there. Run both processes together. Do not put `NVIDIA_API_KEY` or a service-role key into any `VITE_*` variable. Never paste secrets into issue text, screenshots, logs, generated bundles or source control. `.dev.vars.example` is intentionally placeholders only.

## Supabase email-code authentication

1. In the **development Supabase dashboard → SQL Editor**, apply `supabase/schema.sql` and the numbered migrations in `supabase/migrations/` in order. Read the migration notes and make a backup before applying changes to an existing project. Use separate projects for development/preview and production.
2. In **Authentication → Providers → Email**, enable Email and allow sign-ups if desired. Google is unnecessary. Keep email confirmation enabled. Set the email OTP expiry explicitly (recommended 10 minutes) and a suitable token length (6 or 8 digits, matching the UI's supported range).
3. In **Authentication → Email Templates**, change the confirmation/sign-in (Magic Link) template to show the one-time code: `Your DMC sign-in code is {{ .Token }}`. Include `{{ .Token }}` in the body; the flow calls `signInWithOtp` then `verifyOtp({email,token,type:'email'})`. It does not require clicking `{{ .ConfirmationURL }}` or choosing a Google account. Configure the signup template as well because the first sign-in may create an account.
4. In **Authentication → URL Configuration**, set Site URL to `http://localhost:5173` for the development project and `https://mcq.example.com` for production. Code entry needs no redirect, but if you retain any Supabase account recovery flows, explicitly allow their exact origins/paths. Do not use a broad production wildcard for arbitrary preview domains.
5. In **Project Settings → Authentication → SMTP** (dashboard labels can change), configure your mail provider's SMTP host, port, user, password, sender address and sender name. Verify the sender domain with that provider's SPF/DKIM and DMARC records. Use the provider's recommended TLS port. Send a test to actual school and personal mailboxes and check spam/quarantine.
6. Review **Authentication → Rate Limits** and the SMTP provider's daily/monthly limits. Supabase's built-in email sender has restrictive test limits and recipient restrictions; it is unsuitable for a school launch. The UI's 60-second resend cooldown is guidance, while Supabase remains the server authority for throttling and expiry. Codes expire according to Supabase's setting; a resend may invalidate an earlier code. Never log codes.

Existing library membership continues to come from RLS and verified email, not browser account labels or user-editable metadata. Test a school member, a personal account and a guest. Test A → sign out → B on a shared browser. Guest adoption must require an explicit action; shared-device removal must handle pending personal changes before deleting the local cache.

## Build and deploy

In the repository root terminal:

```sh
npm run check
npm run e2e
npm run build
```

Build command: **`npm run build`**. Output directory: **`dist`**. Vite public variables are fixed at build time. Configure `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` separately for the Pages Production and Preview build environments before building; never set a private key there.

### Pages frontend

In **Cloudflare dashboard → Workers & Pages → Create → Pages**, connect the repository, choose the production branch and set build command `npm run build`, output directory `dist`, and Node version 22. Alternatively, from the repository root terminal after authenticating Wrangler:

```sh
npx wrangler pages deploy --config wrangler.pages.toml
```

Replace `name = "dmc"` in `wrangler.pages.toml` with your Pages project name. This file is for Pages only; `wrangler.toml` is for the API Worker. Review deploy targets before running the commands.

### API Worker and Durable Object

Edit placeholders in `wrangler.toml`: Worker name, production origin, Supabase project URL/public key, zone name and route. The binding `AI_BUDGET` must point to exported class `AiBudget`. The `v1-ai-budget` migration creates its SQLite Durable Object namespace on first deployment. Do not remove or rename a deployed migration. Only this Worker may call the provider using this NVIDIA key.

From the repository root terminal, set the secret interactively and deploy:

```sh
npx wrangler secret put NVIDIA_API_KEY
npx wrangler deploy
```

`secret put` stores the private key on the Worker, not Pages. Verify deployment names before supplying it. No secret is required at frontend build time. The Worker intentionally returns a clear 503 when missing its key or binding. Manual import remains available.

### Subdomain, DNS and HTTPS

1. Manage `example.com` in Cloudflare DNS. In **Pages project → Custom domains → Set up a custom domain**, associate `mcq.example.com`. Let Pages create the proxied CNAME pointing to the project's `*.pages.dev` hostname. Adding only a DNS record without the Pages association is insufficient.
2. In **DNS → Records**, confirm the `mcq` record is proxied (orange cloud). Do not add a competing A/CNAME record. Wait for validation and the Universal SSL/custom-domain certificate to become active. Use **SSL/TLS → Full (strict)** and verify HTTPS before sign-in testing.
3. Deploy the Worker route `mcq.example.com/api/*` in the same zone. It runs before Pages for those paths; all other requests reach Pages. This uses a **route**, not a Worker Custom Domain for the whole hostname. Do not bind the whole hostname to the Worker or use a catch-all Pages SPA rewrite for `/api/*`.
4. Set the production Supabase Site URL to `https://mcq.example.com` and Worker `APP_ORIGIN` to the same origin. Verify `GET https://mcq.example.com/api/ai/config` gives 401 without a token and JSON configuration after sign-in, never `index.html`.
5. Use the custom domain for AI import. A bare `project.pages.dev` URL has no zone Worker route and therefore supports manual import but not AI. Do not solve this by exposing an unrestricted cross-origin proxy.

### Development, preview and production separation

| Environment | Frontend | Supabase | Worker / NVIDIA |
| --- | --- | --- | --- |
| Development | localhost:5173, Vite proxy | development project | `wrangler dev --env development`, `.dev.vars`, local DO |
| Preview | fixed `preview-mcq.example.com` Pages custom domain | preview project | `wrangler deploy --env preview`, preview secret and route |
| Production | `mcq.example.com` | production project | default `wrangler deploy`, production secret and route |

The preview example has `routes=[]` to prevent accidentally claiming a hostname. Add the exact preview zone route after associating the custom domain. Set preview `APP_ORIGIN` accordingly and run `npx wrangler secret put NVIDIA_API_KEY --env preview`. Arbitrary branch-preview `*.pages.dev` origins intentionally have no API. Preview and development must use a **separate NVIDIA key/account allowance** or share the same coordinating production Worker; separate DO namespaces cannot coordinate a provider budget if you reuse one key across environments. Do not point preview at production Supabase or quietly use production credentials.

## NVIDIA model and limits

Default model: `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`. Endpoint is fixed in server code: `https://integrate.api.nvidia.com/v1/chat/completions`. The official NVIDIA [Nemotron Nano VL notebook](https://github.com/NVIDIA/GenerativeAIExamples/blob/203b0de48d1142124842d56d4b40f3733888f5ee/nemotron/VLM/llama_3.1_nemotron_nano_VL_8B/Llama_Nemotron_VL_nano_8B.ipynb) was checked during implementation; it demonstrates this model, the `https://integrate.api.nvidia.com/v1` base URL, and `image_url` content containing base64 PNGs. It also demonstrates multiple images. This verifies the documented request format, **not live availability or your key's model entitlement**. Confirm the current model card in NVIDIA's API Catalog and run the optional smoke test before launch. Configure a different vision-capable NVIDIA-hosted model only after verifying its supported messages and image formats. A text-only model will not read scans.

Select only relevant mark-scheme pages: the UI accepts up to three per question-page batch (four total pages), and up to 20 selected question pages per import. For longer papers, process further chunks into the same pack/paper through the existing conflict review; duplicate question numbers must be corrected in review before confirmation. The browser extracts text with existing pdf.js and renders selected pages locally as bounded PNG/JPEG images for scanned or diagram-heavy material. **No chat request contains a raw PDF.** Full PDFs stay in the browser's local workspace; the Worker holds selected page material only for a request and never logs or saves it. NVIDIA receives that material under its own processing/retention terms; the user sees and explicitly starts the transfer. Diagrams use source crops where possible and otherwise remain visibly flagged for review. Without supplied mark-scheme pages, the Worker strips guessed answers and explanations. A key taken from a supplied scheme still needs human review.

| Worker variable | Default | Enforcement |
| --- | --- | --- |
| `NVIDIA_MODEL` | Nemotron Nano VL model above | server-selected, client cannot choose arbitrary endpoint/model |
| `AI_SHARED_RPM` | 30 | rolling 60-second global window, clamped 1–39 |
| `AI_USER_DAILY_REQUESTS` | 100 | verified account; resets on UTC day boundary; max 1000 |
| `AI_CONCURRENCY` | 2 | global active provider calls, clamped 1–8 |
| `AI_MAX_PAGES` | 4 | total question plus mark-scheme pages per request, max 4 |
| `AI_TIMEOUT_MS` | 45000 | provider timeout, max 60000 |
| `AI_MAX_RETRIES` | 1 | server retry count, max 2 |

Payload max is 4,000,000 bytes; text max is 60,000 characters/page; image max is about 1 MB/page; provider response max is 2 MB; output max is 60 questions/batch with stem, option and explanation text bounded to 5000 characters. The named Durable Object stores only request timestamps, expiring concurrency leases and small per-account counters. It does **not** store documents or model payloads. Reservations are storage transactions, so separate Worker isolates cannot each spend their own 40 RPM budget. All failed provider calls and automatic retries consume budget. Provider `Retry-After` is honored; short waits retry within the configured bound, longer waits return a no-store error and Retry-After for the client to retry later. There is no unbounded server queue. Crashed leases expire; cancellations cannot refund a call the provider already received. Do not share the NVIDIA key with another application unless its traffic is included in the same budget.

Requests require a valid Supabase bearer and confirmed email. The Worker rejects unexpected fields, remote image URLs, invalid images, oversized streams and mismatched page metadata. Document instructions are treated as untrusted source text, with no tools, URL fetching or code execution. Model output is strict structured data, rendered through existing safe text components and the importer; invalid/truncated output fails the batch. Source content and answers always need review. A source crop may be inaccurate even when its coordinates are valid.

## Headers, caches and security

`public/_headers` becomes Pages response headers: CSP, noindex, no-referrer, nosniff, frame denial, restricted permissions and HSTS. Update the `connect-src` and `img-src` allowlists explicitly if you use a custom Supabase domain; never add a broad `*`. Question images and PDFs keep their original colors in both themes. The API independently adds `Cache-Control: no-store, private`; Pages headers do not apply to a separately routed Worker.

The service worker must bypass `/api/*`, `/auth/*`, authorization-bearing requests and external Supabase requests. It caches only the static shell/assets, never auth or AI responses. When switching an existing install, accept the new app update/reload so the new service worker activates. Add a Cloudflare Cache Rule that bypasses cache for `/api/*` if the zone has any broad Cache Everything rules. Supabase auth should remain uncached as well.

## Verification and optional live smoke test

Routine CI uses mocked NVIDIA responses and never consumes provider quota. From the repository root terminal:

```sh
npm run typecheck
npx tsc --noEmit -p worker/tsconfig.json
npm run lint
npm test
npm run build
npm run e2e
```

The Worker tests exercise server-side authentication, key secrecy, input/output limits, global coordination, quotas, concurrency release/expiry, retry accounting, Retry-After and cancellation. An in-process storage mock verifies contracts; it does not replace a staging test on the actual Durable Object runtime.

For an **optional paid/quota-consuming live smoke**, explicitly choose a staging environment and a synthetic one-page PDF with two trivial MCQs (include a small diagram for the vision check). In the running app, sign in with a real staging email, choose **Import PDF with AI**, select that page and click its explicit start action. Confirm source-page references, null answers without a scheme, diagram crop/flag, review editing and final import. Repeat once with a synthetic mark-scheme page. Inspect only status codes and counts in Cloudflare metrics—never log payloads, email codes, tokens or keys. Test cancellation and a failed batch with mocked responses in CI instead of burning real quota. A live smoke was not run as part of this change: no real credentials were provided.

## Troubleshooting

- **Code never arrives:** verify both signup and sign-in templates contain `{{ .Token }}`, SMTP sender verification, SPF/DKIM, recipient spam/quarantine, Supabase auth logs and provider delivery logs. Check project and mail-provider limits. Wait for resend cooldown; avoid repeated requests that supersede earlier codes.
- **Code expired/invalid:** use the latest email, confirm configured OTP length/expiry, change email in the dialog if mistyped, then resend. Device clock does not override Supabase expiry. Do not paste a code into logs.
- **Library locked:** confirm server-verified school email and membership tables/RLS. Personal sign-in does not grant school access. Never relax RLS to fix a client issue.
- **`/api` returns HTML/404:** check custom-domain association, proxied DNS, exact Worker route/zone and current deployed Worker name. Pages alone does not serve this API. Check that no SPA rewrite or zone cache rule captures it.
- **401:** real Supabase session required, bearer must match the Worker's project. Sign in again. Mock/local development accounts cannot use a real provider.
- **403:** email must be confirmed and the request's browser Origin must match `APP_ORIGIN`. Local development uses the Vite proxy.
- **503 not configured:** set `NVIDIA_API_KEY` on the correct Worker environment; check `AI_BUDGET` binding/migration and Supabase variables. Pages frontend variables do not configure the Worker.
- **429 or busy:** the shared provider budget, concurrency or account quota has been reached. Honor Retry-After and retry the failed batch. Lower batch size or wait; do not create another Worker to evade the shared budget.
- **NVIDIA access rejected:** check key validity and entitlement to the configured vision model in NVIDIA's dashboard; confirm current model card and image format. Never return provider diagnostic bodies to users.
- **Truncated/invalid extraction:** retry fewer pages; examine the original PDF; correct flagged/missing content in review or use manual import. Model extraction is not evidence that a key or diagram is correct.
- **Old UI after deploy:** inspect service-worker update and shell `no-cache` headers, accept the in-app update, then verify the API is not in Cache Storage.

## Operating cost and limits

Pages static hosting is usually inexpensive; verify current Cloudflare plan limits. The API uses one Worker plus one small Durable Object with requests, transactional reads/writes and active duration charges according to your plan. SQLite-backed objects are supported on current Workers plans; confirm current free/paid quotas before enabling school-wide use. NVIDIA availability, free credits and pricing are account-specific; 40 RPM is a throughput allowance, **not** a promise of free inference. Supabase Auth/Postgres/Storage and SMTP have independent monthly quotas and costs. Monitor requests, 429s, failures, storage and mail delivery in each dashboard. No full PDFs are stored by the API, but manually chosen cloud backups still incur Supabase Storage.

Remaining manual setup: create projects, review/apply SQL, configure SMTP/templates/rate limits, fill public placeholders, set the private Worker secret, associate domains/routes/DNS/HTTPS, and run staging/live smoke tests. Keep production migration, authentication, DNS and deploy changes behind the project owner's explicit authorization.
