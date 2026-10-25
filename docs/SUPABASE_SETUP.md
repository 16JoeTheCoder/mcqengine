# Setting up accounts, sync and the school Library (Supabase)

About 30 minutes, once. You need: a web browser, the Netlify site that hosts DMC, and a Google account to sign in to Supabase and Google Cloud. Nothing here needs a terminal except the optional local test in step 9.

Until these steps are done, DMC works exactly as before: everything on the device, no accounts, the Library shows "not set up". Switching it on is only a matter of the two values in step 7.

**Two rules that matter for safety:**

* Only two values ever go into the app: the **Project URL** and the **anon public key** (newer projects call it the **publishable key**, starting `sb_publishable_`). Both are designed to be public; the database rules protect the data.
* **Never** put the `service_role` key (or a `sb_secret_` key) anywhere in DMC, Netlify or a file in the repository. It bypasses every rule.

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

## 4. Email sign-in

Where: Supabase dashboard > **Authentication** > **Sign In / Providers**.

1. **Email** is on by default. Make sure **Confirm email** is **on**: the Library only admits confirmed addresses.
2. DMC uses sign-in links (no passwords). Supabase's built-in mailer sends only a few emails per hour, which is fine for testing. For the whole school, set up your own mail sender under **Authentication** > **Emails** > **SMTP Settings** (any provider such as Resend or Brevo; follow their Supabase instructions), or ask students to use Google.

## 5. Google sign-in

Where: browser, [console.cloud.google.com](https://console.cloud.google.com), then the Supabase dashboard.

1. In Google Cloud: create a project named `dmc` (project picker at the top > **New project**).
2. **APIs & Services** > **OAuth consent screen**: choose **External**, app name `DMC`, your email as support and developer contact. Save. Add the scope `email` and `profile` if asked. Publish the app (**Publish app**) so any Google account can sign in.
3. **APIs & Services** > **Credentials** > **Create credentials** > **OAuth client ID** > **Web application**.
4. In the Supabase dashboard > **Authentication** > **Sign In / Providers** > **Google**, copy the **Callback URL** shown there (it ends in `/auth/v1/callback`).
5. Back in Google Cloud, paste it under **Authorised redirect URIs**, press **Create**, and copy the **Client ID** and **Client secret**.
6. In Supabase > **Google**: turn it on, paste the Client ID and Client secret, **Save**.

About the school domain: "Sign in with school email" asks Google to show the `stjbs.sch.id` account first. That is only a convenience. Who reaches the Library is decided by the database rules from step 2, which check the confirmed email on the server.

## 6. Where DMC lives

Where: Supabase dashboard > **Authentication** > **URL Configuration**.

1. **Site URL**: your Netlify address, for example `https://dmc-practice.netlify.app`.
2. **Redirect URLs**: press **Add URL** and add the same address followed by `/**` (for example `https://dmc-practice.netlify.app/**`), and `http://localhost:5173/**` for local testing.

## 7. Give the app its two public values

Where: Supabase dashboard, then the Netlify dashboard.

1. Supabase > **Project Settings** (gear) > **API Keys** (or **Data API**): copy the **Project URL** and the **anon public** key (or the **publishable** key).
2. Netlify > your site > **Site configuration** > **Environment variables** > **Add a variable**:
   * Key `VITE_SUPABASE_URL`, value: the Project URL.
   * Key `VITE_SUPABASE_ANON_KEY`, value: the anon or publishable key.
3. Netlify > **Deploys** > **Trigger deploy** > **Deploy site**. When it finishes, DMC shows **Sign in** in the top bar and the **Library** link.

## 8. Check it works

Where: browser, on the deployed site.

1. Sign in with a school address. The account menu (the letter in the top bar) should say "School Library: member".
2. Open **Library** > **Post a set**, choose a pack, post it. It appears with your name.
3. In a private window, sign in with a personal Gmail address. **Library** should say it is locked, with one line on how to unlock it.
4. As the admin, the set's **Remove** button works.

## 9. Optional: test locally

Where: VS Code terminal (or Ubuntu/WSL terminal), in the repository folder.

```bash
cp .env.example .env.local     # then put the two values from step 7 into .env.local
npm run dev                    # http://localhost:5173
```

`.env.local` is ignored by git. Without it, `npm run dev` uses a built-in development backend that lives in the browser and follows the same rules, so all features can be tried with made-up addresses.

## How the rules are proven

`npm test` (repository root, any terminal) runs `tests/unit/rls.test.ts`, which loads `supabase/schema.sql` into a real Postgres engine and checks, account by account, that a school account can list, read and download a set while personal, unconfirmed, spoofed and anonymous accounts cannot; that only owners and admins remove sets; that stars are one per person; and that sync records are private to their owner.

## Limits built into the rules

| What | Limit |
| --- | --- |
| Set file | 100 MB |
| Library storage per person | 400 MB and 100 files |
| Sets per person | 40 |
| Private backup file | 200 MB |
| Sync | 500 records per push, 50 000 per account, 256 KB per record |
| Reports | 3 distinct reports hide a set until an admin restores or removes it |
