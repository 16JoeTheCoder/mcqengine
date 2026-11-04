# Setting up accounts, sync and the school Library (Supabase)

Use a browser to configure Supabase, and Cloudflare Pages for the frontend. The app uses email verification codes: students and teachers do not need a Google account. See [CLOUDFLARE_SETUP.md](CLOUDFLARE_SETUP.md) for the complete development, preview, production, Worker and subdomain guide.

Until these steps are done, DMC works exactly as before: everything on the device, no accounts, the Library shows "not set up". Switching it on is only a matter of the two values in step 7.

**Two rules that matter for safety:**

* Only two values ever go into the app: the **Project URL** and the **anon public key** (newer projects call it the **publishable key**, starting `sb_publishable_`). Both are designed to be public; the database rules protect the data.
* **Never** put the `service_role` key (or a `sb_secret_` key) anywhere in frontend variables, Cloudflare Pages builds or a file in the repository. It bypasses every rule.

## 1. Create the project

Where: browser, [supabase.com](https://supabase.com).

1. Sign in, then **New project**.
2. Organisation: your own. Name: `dmc`. Database password: press **Generate a password** and save it in your password manager (DMC never needs it).
3. Region: **Southeast Asia (Singapore)**, closest to Jakarta.
4. Press **Create new project** and wait about two minutes until the dashboard opens.

## 2. Create the tables, rules and storage

Where: Supabase dashboard > **SQL Editor** (left sidebar).

1. Press **New query**.
2. Open [`supabase/schema.sql`](../supabase/schema.sql) from this repository (on GitHub: open the file, press **Raw**, select all, copy).
3. Paste it into the editor and press **Run**. It should finish with "Success. No rows returned".

This creates the Library tables (sets, stars, reports), the sync table, the row-level security rules, and two **private** storage buckets, `sets` and `backups`. Running it again later is safe; do that after any update to the file.

Check: **Storage** (left sidebar) now lists `sets` and `backups`, both marked private (no "Public" badge).

## 3. Who can use the Library

Where: Supabase dashboard > **Table Editor** (left sidebar).

* **`library_domains`** already holds `stjbs.sch.id`. Every confirmed account with an address at that domain can use the Library. Leave it as it is unless the school's domain changes.
* **`library_allowlist`**: exceptions, such as a teacher with another address. Press **Insert** > **Insert row**, type the email in lowercase, optionally a note, press **Save**.
* **`library_admins`**: you. Insert a row with your own school email (lowercase). Admins can remove any set at once and restore a set hidden by reports. Admins must also be Library members (school domain or allowlist).

To remove someone: delete their row. Changes apply immediately.

## 4. Email verification codes and delivery

Where: Supabase dashboard > **Authentication** > **Sign In / Providers** > **Email**.

1. Enable Email sign-in and keep **Confirm email** on. Library access is enforced from the verified address by database and storage policies.
2. Under **Authentication** > **Emails** > **Templates**, use `{{ .Token }}` in both the **Confirm signup** and **Magic Link** templates, for example: `Your DMC sign-in code is {{ .Token }}.` Do not direct the user to open a sign-in link. Supabase uses the Magic Link template name for existing-user OTP messages even though DMC verifies the code inside the app.
3. Configure a short **Email OTP expiry** (for example 600 seconds), and a matching clear statement in the email. The server decides expiry; DMC reports an expired or invalid code and offers resend/change-email.
4. Configure custom SMTP under **Authentication** > **Emails** > **SMTP Settings** before a school pilot. Set the provider host, port, credentials and verified sender there. Set SPF, DKIM and DMARC using that provider's DNS instructions, then check delivery and spam placement with a school mailbox and a personal mailbox.
5. Review **Authentication** > **Rate Limits** and your SMTP provider's sending limits. Supabase's default mail service is restricted and unsuitable for general school delivery. The app's resend cooldown does not replace server-side abuse protection or increase mail quotas.

No Google OAuth application or account chooser is required. Other providers may remain disabled.

## 5. Site URL and redirect allowlist

Where: Supabase dashboard > **Authentication** > **URL Configuration**.

Set **Site URL** to the canonical production origin, for example `https://mcq.example.com`. Code verification occurs inside DMC and does not require a redirect to complete sign-in. If you retain a fallback auth link, allow only the exact origins and paths you intentionally support. Use a separate development Supabase project for `http://localhost:5173` and preview testing; do not grant every preview host access to production authentication.

## 6. Give the frontend its two public values

Where: Supabase dashboard > **Project Settings** > **API Keys** (or **Data API**), then Cloudflare dashboard > **Workers & Pages** > the Pages project > **Settings** > **Variables and Secrets**.

Set `VITE_SUPABASE_URL` to the Project URL and `VITE_SUPABASE_ANON_KEY` to the anon/public or publishable key. Configure Production and Preview separately, then rebuild the relevant frontend deployment. These values are built into JavaScript and are public. Keep the NVIDIA key in Worker secrets, never in a `VITE_*` variable.

## 7. Existing projects and migrations

Back up production data before a planned schema upgrade. Review the migration in `supabase/migrations/` alongside the new `schema.sql`; apply it in a staging project first. SQL tests use PGlite stand-ins for Supabase Auth and Storage and cannot replace a staging check of hosted policies and email delivery. Changing a live project's authentication or data requires explicit authorization.

## 8. Check it works

Where: browser, on the deployed site.

1. Enter a school address, request the code, and enter the code from the email. The account menu (the letter in the top bar) should say "School Library: member".
2. Open **Library** > **Post a set**, choose a pack, post it. It appears with your name.
3. In a private window, sign in by code with a personal email address. **Library** should say it is locked, with one line on how to unlock it.
4. As the admin, the set's **Remove** button works.

## 9. Test locally

Where: VS Code terminal (or Ubuntu/WSL terminal), in the repository folder.

```bash
cp .env.example .env.local     # then put the two values from step 7 into .env.local
npm run dev                    # http://localhost:5173
```

`.env.local` is ignored by git. Without it, `npm run dev` uses a built-in development backend that lives in the browser and follows the same rules, so the account and Library flows can be exercised with made-up addresses. Mock codes do not send email and do not authorize production AI requests.

## How the rules are proven

`npm test` (repository root, any terminal) runs `tests/unit/rls.test.ts`, which loads `supabase/schema.sql` into a real Postgres engine and checks, account by account, that a school account can list, read and download a set while personal, unconfirmed, spoofed and anonymous accounts cannot; that only owners and admins remove sets; that stars are one per person; and that sync records are private to their owner.

## Limits built into the rules

| What | Limit |
| --- | --- |
| Set file | 100 MB |
| Library storage per person | 400 MB and 100 files |
| Sets per person | 40 |
| Private backups | 200 MB per file, at most 3 files and 400 MB per account |
| Sync | 500 records / 4 MB per push, 50 000 per account, 256 KB per record |
| Reports | 3 distinct reports hide a set until an admin restores or removes it |
