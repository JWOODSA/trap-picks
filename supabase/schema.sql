-- Trap Picks accounts on Supabase. Run once in the Supabase dashboard: SQL Editor, New query, paste, Run.
--
-- docs     every saved thing (picks, groups, pick'em, fantasy leagues), stored by path the same way the
--          Claude version stores them, so the app code is shared. Private paths (data/users/<id>/...) are
--          readable only by their owner; everything else is readable by signed-in users. Only the person
--          who wrote a row can change or delete it.
-- profiles name and picture for leaderboards, filled in at sign-up.
-- billing  Pro status, written only by the server (Stripe webhook); each person can read their own.

create table if not exists public.docs (
  path text primary key,
  data jsonb not null,
  owner uuid not null default auth.uid() references auth.users on delete cascade,
  updated_at timestamptz not null default now()
);
create index if not exists docs_path_prefix on public.docs (path text_pattern_ops);
create index if not exists docs_data on public.docs using gin (data jsonb_path_ops);
alter table public.docs enable row level security;

drop policy if exists docs_read on public.docs;
create policy docs_read on public.docs for select to authenticated
  using (path not like 'data/users/%' or path like 'data/users/' || auth.uid()::text || '/%');
drop policy if exists docs_insert on public.docs;
create policy docs_insert on public.docs for insert to authenticated
  with check (owner = auth.uid()
    and (path not like 'data/users/%' or path like 'data/users/' || auth.uid()::text || '/%')
    and (path not like 'members/%' or path = 'members/' || auth.uid()::text)
    and (path not like 'diag/%' or path = 'diag/live_' || auth.uid()::text));
drop policy if exists docs_update on public.docs;
create policy docs_update on public.docs for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());
drop policy if exists docs_delete on public.docs;
create policy docs_delete on public.docs for delete to authenticated using (owner = auth.uid());

create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text,
  avatar_url text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated using (true);
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create table if not exists public.billing (
  id uuid primary key references auth.users on delete cascade,
  stripe_customer text,
  subscription text,
  status text,
  plan text,
  pro_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.billing enable row level security;
drop policy if exists billing_read_own on public.billing;
create policy billing_read_own on public.billing for select to authenticated using (id = auth.uid());
-- No insert/update policies: only the server (service role key) writes billing.

-- New sign-ups get a profile: Google gives a name and picture; email sign-ups use the part before the @.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, avatar_url)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
          new.raw_user_meta_data->>'avatar_url')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Live updates for leaderboards, drafts and pick'em.
do $$ begin
  alter publication supabase_realtime add table public.docs;
exception when duplicate_object then null; end $$;

-- Push alerts. Both tables are server only (service role key): no policies, so the browser can't read them.
-- push_subs  one row per phone or browser that turned alerts on; user_id is set when signed in (for Pro alerts).
-- push_sent  every alert that went out, so each one is sent once.
create table if not exists public.push_subs (
  endpoint text primary key,
  p256dh text not null,
  auth text not null,
  user_id uuid references auth.users on delete cascade,
  prefs jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.push_subs enable row level security;
create table if not exists public.push_sent (
  id text primary key,
  kind text not null,
  data jsonb,
  delivered int not null default 0,
  sent_at timestamptz not null default now()
);
alter table public.push_sent enable row level security;
-- One shared copy of every sportsbook's lines per sport (functions/api/odds.js), server only.
create table if not exists public.odds_cache (
  sport text primary key,
  fetched_at timestamptz not null default now(),
  remaining integer,
  data jsonb not null default '{}'
);
alter table public.odds_cache enable row level security;
-- Each college game's lines from every scheduled pull before tip-off (lib/odds.js scheduledOdds);
-- the row's last version before start is the closing line. Server only.
create table if not exists public.odds_close (
  sport text not null,
  gkey text not null,
  start timestamptz not null,
  away text not null,
  home text not null,
  at timestamptz not null,
  data jsonb not null,
  primary key (sport, gkey)
);
create index if not exists odds_close_start on public.odds_close (sport, start);
alter table public.odds_close enable row level security;

-- In-app feedback (functions/api/feedback.js writes with the service role; no public access).
create table if not exists public.feedback (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('bug','idea','other')),
  message text not null check (char_length(message) between 3 and 2000),
  page text, sport text, app_build text,
  user_id uuid references auth.users(id) on delete set null,
  email text, user_agent text,
  status text not null default 'new'
);
alter table public.feedback enable row level security;
revoke all on public.feedback from anon, authenticated;
create index if not exists feedback_created_idx on public.feedback (created_at desc);
