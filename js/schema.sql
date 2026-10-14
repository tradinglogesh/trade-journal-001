-- Trade Journal schema (Supabase). Run in the SQL Editor on a fresh project.
-- Every table is protected by Row Level Security: users only see their own rows.

create extension if not exists "uuid-ossp";

-- Sync tables: one row per journal / trade / plan (JSON document)
create table if not exists public.app_journals (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  data jsonb not null,
  updated_at timestamptz default now(),
  primary key (user_id, id)
);
create table if not exists public.app_entries (like public.app_journals including all);
create table if not exists public.app_plans   (like public.app_journals including all);

-- Last-change marker; other devices poll this tiny row to know when to sync
create table if not exists public.app_sync_meta (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  data_updated_at bigint default 0
);

create table if not exists public.backups (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  backup_name text,
  backup_data jsonb,
  created_at timestamptz default now(),
  created_by text default 'manual',
  size_kb integer
);

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  name text,
  handle text,
  theme text default 'light',
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Row Level Security
alter table public.app_journals  enable row level security;
alter table public.app_entries   enable row level security;
alter table public.app_plans     enable row level security;
alter table public.app_sync_meta enable row level security;
alter table public.backups       enable row level security;
alter table public.user_profiles enable row level security;

do $$
declare t text;
begin
  foreach t in array array['app_journals','app_entries','app_plans','app_sync_meta'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format('create policy "own rows" on public.%I for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
  end loop;
end $$;

drop policy if exists "Users can view own backups" on public.backups;
drop policy if exists "Users can insert own backups" on public.backups;
drop policy if exists "Users can delete own backups" on public.backups;
create policy "Users can view own backups"   on public.backups for select to authenticated using (user_id = auth.uid());
create policy "Users can insert own backups" on public.backups for insert to authenticated with check (user_id = auth.uid());
create policy "Users can delete own backups" on public.backups for delete to authenticated using (user_id = auth.uid());

drop policy if exists "Users can view own profile" on public.user_profiles;
drop policy if exists "Users can insert own profile" on public.user_profiles;
drop policy if exists "Users can update own profile" on public.user_profiles;
create policy "Users can view own profile"   on public.user_profiles for select to authenticated using (id = auth.uid());
create policy "Users can insert own profile" on public.user_profiles for insert to authenticated with check (id = auth.uid());
create policy "Users can update own profile" on public.user_profiles for update to authenticated using (id = auth.uid());

-- Auto-create a profile row when a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Private image storage: one folder per user (<user_id>/<file>), webp/jpeg/png, max 2 MB
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('trade-images', 'trade-images', false, 2097152, array['image/webp','image/jpeg','image/png'])
on conflict (id) do update set public = false, file_size_limit = 2097152,
  allowed_mime_types = array['image/webp','image/jpeg','image/png'];

do $$
declare op text;
begin
  foreach op in array array['select','insert','update','delete'] loop
    execute format('drop policy if exists "trade-images %s own" on storage.objects', op);
  end loop;
end $$;
create policy "trade-images select own" on storage.objects for select to authenticated
  using (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "trade-images insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "trade-images update own" on storage.objects for update to authenticated
  using (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "trade-images delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'trade-images' and (storage.foldername(name))[1] = auth.uid()::text);
