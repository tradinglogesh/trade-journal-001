# Trade Journal

Single-page trading journal (`index.html`) with Supabase Auth, Postgres (RLS) and private Storage.

```
index.html          app (UI + logic)
serve.js            tiny static server, exposes public Supabase keys at /api/env
js/                 supabase-auth, supabase-db, supabase-storage, sync-merge, backup, schema.sql
lib/                xlsx.full.min.js
tests/              node --test tests/sync-auth.test.js
```

Run: copy `.env.local.example` to `.env.local`, fill in the keys, then `node serve.js` and open http://localhost:8080.
See `MIGRATION_GUIDE.md` for Supabase setup, backups and tests.
