# Trade Journal – Setup Guide (Supabase only)

Stack: Supabase Auth (email/password) · Supabase Postgres (RLS) · Supabase Storage (private images). No Google or Cloudflare services.

## 1. Setup
1. Create a Supabase project.
2. Run `js/schema.sql` in **SQL Editor** (tables, RLS, profile trigger, `trade-images` bucket).
3. Create `.env.local` next to `serve.js`:
   ```
   SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_ANON_KEY=<publishable key>
   ```
4. Run `node serve.js` and open http://localhost:8080.
5. **Auth → URL Configuration**: set Site URL (and add Redirect URLs) to the address you serve the app from. Password-reset links return there.

## 2. How data works
- Each journal, trade and plan is its own row in `app_journals`, `app_entries`, `app_plans`.
- Screenshots are uploaded as WebP to the private `trade-images` bucket; rows store only `sb:<uid>/<file>` references.
- **Sync** is a per-row three-way merge: edits on two devices to *different* trades both survive; on the same trade the newest edit wins; an edit beats a delete.
- Changes upload ~3 s after you edit. Other open devices pick them up within ~20 s (polling `app_sync_meta`) or when the tab regains focus.

## 3. Email confirmation and password reset (before inviting other traders)
Supabase's built-in mailer only reaches team members and is heavily rate-limited, so configure real SMTP first:
1. Create an account with an email provider (Resend, Brevo, Postmark…) and verify your sending domain.
2. **Auth → SMTP Settings** → enable custom SMTP and enter host, port, user, password, sender.
3. **Auth → Sign In / Providers → Email** → turn on **Confirm email**.
4. Test: sign up, receive the confirmation mail; use **Forgot password?** on the sign-in screen.

Until SMTP is set up, keep Confirm email OFF (current setting) or sign-ups will fail.

## 4. Backups
- Cloud backup saved to `backups` daily (last 10 kept; the largest is never deleted).
- A reminder popup appears every 10 minutes while the app is open, with **Download JSON**, **Sync** and **Cancel**. Logout also offers a JSON download.
- Manual export/import is in Settings (Import accepts both file layouts).

## 5. Tests
```
node --test tests/sync-auth.test.js
```
Covers merge/conflict rules and login/token/password-reset helpers (no npm needed).

## 6. Migrating from the older version
Legacy tables (`trades`, `entries`, `journals`, `trading_plans`, `accounts`, `user_settings`, `trade_images`, `images`) were dropped; only the tables in `schema.sql` are used. Existing base64 screenshots are converted to Storage files automatically on the first sync.
