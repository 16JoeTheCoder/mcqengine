# DMC on Cloudflare: setup, deploy, migrate, roll back

Written for an agent (or a person) holding a Cloudflare API token with full permissions on the student council account. Follow the steps **in order**. Every command runs in **Windows PowerShell, in the repository folder** (`mcqengine`), unless a step says otherwise. Each step says how to check it worked.

* Account: `Stjbscouncil@gmail.com's Account`, account ID `e82975af2f29158ff3d04995aa5d7ed9`. The zone `stjbscouncil.org` is already in it.
* Production: Worker `dmc` at `https://dmc.stjbscouncil.org`, D1 `dmc-prod`, R2 `dmc-files`.
* Staging: Worker `dmc-staging` at `https://dmc-staging.stjbscouncil.org`, D1 `dmc-staging`, R2 `dmc-files-staging`, its own Google OAuth client.
* One Worker serves the app and `/api/*`. Nothing else is hosted anywhere (no Supabase, no Pages project).

The one step a person must do by hand, creating the Google OAuth clients, is [section B](#b-google-oauth-clients-by-hand-in-google-cloud-console). Do it before step 5.

---

## A. Deploy

### 1. Tools and credentials

Node 22 and Git are installed. In Windows PowerShell, in the repo folder:

```powershell
npm ci
```

```powershell
$env:CLOUDFLARE_API_TOKEN = "<the council account API token>"
$env:CLOUDFLARE_ACCOUNT_ID = "e82975af2f29158ff3d04995aa5d7ed9"
```

```powershell
npx wrangler whoami
```

Check: the output names `Stjbscouncil@gmail.com's Account`. If it names another account, stop: the token is for the wrong account.

### 2. Run the checks once

```powershell
npm run check
```

Check: it ends with the build output and no errors.

### 3. Create the databases

```powershell
npx wrangler d1 create dmc-staging --location apac
```

```powershell
npx wrangler d1 create dmc-prod --location apac
```

Each prints a `database_id`. Open `wrangler.toml` and replace every `REPLACE_WITH_STAGING_D1_ID` (two places: `[env.staging]` and `[previews]`) and `REPLACE_WITH_PROD_D1_ID` with them. Commit that change (the IDs are not secrets). Until this is done, branch preview builds fail at upload.

Check D1 Time Travel, the second safety net beside the nightly backups (7 days on the Workers Free plan, 30 days on Workers Paid):

```powershell
npx wrangler d1 time-travel info dmc-prod
```

Check: it prints a current bookmark. Note in `decision.md` which plan the account is on (Cloudflare dashboard > Billing > Subscriptions), and so whether Time Travel keeps 7 or 30 days.

### 4. Create the file buckets

```powershell
npx wrangler r2 bucket create dmc-files --location apac
```

```powershell
npx wrangler r2 bucket create dmc-files-staging --location apac
```

Check: `npx wrangler r2 bucket list` shows both. The buckets stay private: never add a public `r2.dev` URL or a custom domain to them. Files are served only by the Worker, to signed-in members.

### 5. Apply the database schema

`migrations/0002_seed.sql` makes `josef.yang@stjbs.sch.id` the first admin. If the owner's school address is different, change it there **before** this step.

```powershell
npx wrangler d1 migrations apply dmc-staging --remote --env staging
```

```powershell
npx wrangler d1 migrations apply dmc-prod --remote
```

Check:

```powershell
npx wrangler d1 execute dmc-prod --remote --command "SELECT email FROM library_admins"
```

It lists the admin address.

### 6. Set the secrets

Secrets are never written in files or chat. Each `secret put` asks for the value. Do staging with the **staging** Google client and production with the **production** one (section B).

Make a session secret for each environment (a different one each), and paste it when asked:

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

Staging:

```powershell
npx wrangler secret put SESSION_SECRET --env staging
```

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID --env staging
```

```powershell
npx wrangler secret put GOOGLE_CLIENT_SECRET --env staging
```

```powershell
npx wrangler secret put NVIDIA_API_KEY --env staging
```

Production:

```powershell
npx wrangler secret put SESSION_SECRET
```

```powershell
npx wrangler secret put GOOGLE_CLIENT_ID
```

```powershell
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

```powershell
npx wrangler secret put NVIDIA_API_KEY
```

`NVIDIA_API_KEY` is the key from build.nvidia.com (40 requests a minute; the Worker caps itself at 38). Check: `npx wrangler secret list --env staging` and `npx wrangler secret list` each show the four names (never values). The first `secret put` before a first deploy may ask to create the Worker: answer yes.

### 7. Build and deploy staging

```powershell
npm run build
```

```powershell
npx wrangler deploy --env staging
```

This also attaches the custom domain `dmc-staging.stjbscouncil.org` (DNS record and certificate are created automatically, because the zone is in the same account), the nightly cron trigger (`0 17 * * *`, 00:00 Asia/Jakarta) and Workers Observability.

Check, after a minute for the certificate:

```powershell
Invoke-RestMethod https://dmc-staging.stjbscouncil.org/api/health
```

It shows `ok: True`, `d1: True`, `r2: True`, `ai.configured: True`, `auth.configured: True`, `environment: staging`. Also check the cron: Cloudflare dashboard > Workers & Pages > `dmc-staging` > Settings > Trigger events shows `0 17 * * *`.

### 8. Check every flow on staging, in a browser

Open `https://dmc-staging.stjbscouncil.org`. Tick each:

1. Sign in with a **school** Google account: the account menu says "School Library: member".
2. Sign in with a **personal** Google account in another browser profile: the Library says it is locked; Settings shows Sync off by default.
3. School account: Library > Post a set > choose a question paper and mark scheme PDF named like `9702_s24_qp_12.pdf` / `9702_s24_ms_12.pdf`. The papers table shows the key as Found. Post. The stepped progress runs Checking, Uploading file x of y, Publishing.
4. Second school account (or the same in another profile): Download. The paper set opens; start a paper with "PDF and answer sheet". Answer, submit, see results.
5. A typed set (from AI import or a paper-set zip): start with "Typed questions" (DMC mode); Random and Mistakes drill work.
6. Owner: change something and post again: the card says version 2. The second account sees "Update available", updates, and still has one copy.
7. AI import: Upload papers > AI import with a short PDF; the queue position or progress shows; the draft validates.
8. Admin (the seeded address): Library > Admin. Storage, Downloads, access lists, moderation and AI status load. Press **Test key**: "The key works". Press **Run backup now**: a dated backup appears under Daily.
9. Report a set three times from three accounts: it hides; Admin > Restore brings it back.

### 9. Copy the pilot from Supabase (once)

The live Supabase project still serves the pilot. This copies its sets (keeping each set's ID, so packs students already downloaded stay linked), stars, reports, allowlist, admins, accounts, synced progress and files. Get the service-role key from Supabase dashboard > Project Settings > API (`service_role`). Never commit or paste it anywhere else.

```powershell
$env:SUPABASE_URL = "https://dnlktutorkidejlljqjo.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "<service_role key>"
```

Dry run first (writes `migration-out\`, uploads nothing, prints counts, problems and the pilot's real file sizes):

```powershell
node scripts/migrate-supabase.mjs --env staging --dry-run
```

Paste the size lines into `log.md` under "Pilot file sizes". Then into staging, check it (step 8, items 3 to 6, with a migrated set), then production:

```powershell
node scripts/migrate-supabase.mjs --env staging
```

```powershell
node scripts/migrate-supabase.mjs --env production
```

The script refuses to run into a database that already has sets. Migrated students sign in with Google using the same email; their account (and synced progress) is linked on first sign-in. Afterwards:

```powershell
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY
Remove-Item -Recurse migration-out
```

Keep the Supabase project read-only for two weeks, then pause it.

### 10. Deploy production

```powershell
npm run build
```

```powershell
npx wrangler deploy
```

Check:

```powershell
Invoke-RestMethod https://dmc.stjbscouncil.org/api/health
```

`ok: True` and `environment: production`. Repeat step 8 items 1, 3, 4 and 8 on production.

Automatic builds from GitHub (optional): in the dashboard, **Workers & Pages → dmc → Settings → Builds**, connect `16JoeTheCoder/mcqengine` on the council account. Build command `npm run build`; deploy command `npx wrangler deploy` for `main`; non-production branches run `npx wrangler preview`, which uses the `[previews]` block in `wrangler.toml` (staging D1 and R2, its own Durable Object, no Google sign-in). Disconnect any older build connected to this repository on another account (it builds a Worker named `mcqengine`, which no longer matches `wrangler.toml`), or every pull request shows a failed check.

### 11. Roll back

Code: list recent versions and roll back to the one before.

```powershell
npx wrangler deployments list
```

```powershell
npx wrangler rollback <version-id>
```

(add `--env staging` for staging). The database is not touched by a code rollback; migrations only ever add.

Database, recent mistake (within the Time Travel window):

```powershell
npx wrangler d1 time-travel restore dmc-prod --timestamp "2026-11-20T08:00:00+07:00"
```

It prints the previous bookmark; keep it to undo the restore (`--bookmark <it>`).

Database, from a nightly backup (any of the 7 daily or 4 weekly copies; listed in Admin > Backups):

```powershell
$date = "2026-11-20"
$tables = "library_domains","library_allowlist","library_admins","users","blobs","sets","set_versions","blob_refs","papers","stars","reports","sync_records","counters","usage_daily","user_backups"
New-Item -ItemType Directory -Force restore-$date | Out-Null
npx wrangler r2 object get "dmc-files/backups/daily/$date/manifest.json" --file "restore-$date\manifest.json" --remote
foreach ($t in $tables) { npx wrangler r2 object get "dmc-files/backups/daily/$date/$t.jsonl.gz" --file "restore-$date\$t.jsonl.gz" --remote }
```

```powershell
node scripts/restore-backup.mjs restore-$date restore.sql
```

```powershell
npx wrangler d1 execute dmc-prod --remote --file restore.sql
```

It replaces every backed-up table with the backup's rows. Sessions are not backed up, so everyone signs in again. Files are not in backups: R2 keeps them, and files deleted since the backup are collected only 7 days after nothing points at them.

---

## B. Google OAuth clients (by hand, in Google Cloud Console)

Make two clients, one for staging and one for production. Use the council's Google account.

1. Open https://console.cloud.google.com and sign in.
2. Top bar > project picker > **New project**. Name: `DMC`. Create, then select it.
3. Left menu > **Google Auth Platform** (or **APIs & Services > OAuth consent screen**) > **Get started**.
   * App name: `DMC`. User support email: the council address.
   * Audience: **External** (personal Google accounts may sign in for sync; the Library is locked to school accounts by the server).
   * Contact email: the council address. Agree and **Create**.
4. **Branding**: App domain > Home page `https://dmc.stjbscouncil.org`. Authorised domains: add `stjbscouncil.org`. Save.
5. **Data access** > **Add or remove scopes**: tick `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`. Update, Save. These are non-sensitive scopes, so Google's verification review is not needed.
6. **Audience** > Publishing status > **Publish app** > Confirm. (In "Testing", only listed test users can sign in.)
7. **Clients** > **Create client**:
   * Application type: **Web application**. Name: `DMC production`.
   * Authorised JavaScript origins: none needed.
   * Authorised redirect URIs > Add URI: `https://dmc.stjbscouncil.org/api/auth/google/callback`
   * **Create**. Copy the **Client ID** and **Client secret** (the secret is shown once; download the JSON if offered and keep it offline).
8. **Create client** again: name `DMC staging`, redirect URI `https://dmc-staging.stjbscouncil.org/api/auth/google/callback`. Copy its ID and secret.
9. Give the four values to whoever runs step 6 of section A, through a password manager or in person, never in chat or a file in the repo.

If sign-in later shows `redirect_uri_mismatch`, the URI in step 7 or 8 does not exactly match the site address (https, no trailing slash).

---

## C. Local development

* App only, with the in-browser mock backend (no Cloudflare needed), in the VS Code terminal:

  ```powershell
  npm run dev
  ```

  Opens http://localhost:5173. Sign in with any email under "Development sign-in"; `@stjbs.sch.id` addresses unlock the Library, `josef.yang@stjbs.sch.id` is admin.

* The real Worker with local D1 and R2 (no Google: a development sign-in route exists only in the `local` environment):

  ```powershell
  npm run worker:local
  ```

  Opens http://localhost:8787. This builds the app with the Cloudflare backend, applies the migrations to the local database in `.wrangler/state`, and starts `wrangler dev --env local`.

* Tests: `npm run check` (unit, including the Worker route tests in workerd) and `npm run e2e` (Playwright).
