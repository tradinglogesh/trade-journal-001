# 📈 Trade Journal

A personal trading journal for tracking trades, journals/accounts, plans, analytics, calendar and prop-firm certificates.

🌐 **Live app:** https://tradinglogesh.github.io/trade-journal-001/

## Features

- Email + password sign-up / login, with forgot-password
- Multiple journals (challenge, verification, funded accounts)
- Trades with P&L, R:R, pair, session, emotion and up to 5 chart screenshots
- Analysis, calendar, streaks and top pairs
- Certificates (account cleared / withdrawals)
- Cloud sync across devices (per-trade merge, auto-refresh every 20 s)
- Backups: manual JSON download, cloud backup, Excel export, and a reminder popup every 10 minutes
- Light and dark theme

## How it works

| Part | Technology |
|------|------------|
| Frontend | Plain HTML/JS (`index.html`), hosted on GitHub Pages |
| Login | Supabase Auth (email/password) |
| Database | Supabase Postgres with Row Level Security (each user sees only their own data) |
| Images | Supabase Storage (private bucket) |

The Supabase URL and publishable key in `js/config.js` are public by design. Data is protected by Row Level Security. Never put a secret or service-role key in this repo.

## Project structure

```
index.html          app (UI + logic)
privacy.html        privacy policy
serve.js            optional local server (also serves /api/env)
js/config.js        public Supabase URL + publishable key
js/                 supabase-auth, supabase-db, supabase-storage, sync-merge, backup, schema.sql
lib/                xlsx.full.min.js (Excel export)
tests/              node --test tests/sync-auth.test.js
```

## Run locally

1. Copy `.env.local.example` to `.env.local` and fill in the Supabase keys.
2. Run `node serve.js`
3. Open http://localhost:8080

## Deploy (GitHub Pages)

1. Push to the `main` branch.
2. Repo → Settings → Pages → Source: `main` / root.
3. In Supabase → Authentication → URL Configuration, set **Site URL** to the live URL above and add it to the redirect URLs.
4. Run `js/schema.sql` once in the Supabase SQL Editor for a new project.

## Before inviting other users

- Turn **Confirm email** on in Supabase Auth and set up a custom SMTP email service.
- Ask users to download a JSON backup regularly (Settings).

See `MIGRATION_GUIDE.md` for Supabase setup, backups and tests.
