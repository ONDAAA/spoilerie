-- Spoilerie Supabase schema
-- Run this in the Supabase SQL editor after creating a project

-- ── User profiles (extends Supabase auth.users) ──────────────────────────

create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  email text,
  tier text not null default 'free' check (tier in ('free', 'pro')),
  requests_today integer not null default 0,
  requests_reset_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "Users can read own profile"
  on public.profiles for select
  using (auth.uid() = id);

create policy "Users can update own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create profile on signup
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ── API keys ─────────────────────────────────────────────────────────────

create table if not exists public.api_keys (
  id uuid default gen_random_uuid() primary key,
  user_id uuid references public.profiles on delete cascade not null,
  key_hash text not null unique,       -- sha256 of the actual key
  key_prefix text not null,            -- first 8 chars for display: "sk_abc1..."
  name text not null default 'Default',
  is_active boolean not null default true,
  last_used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.api_keys enable row level security;

create policy "Users can manage own API keys"
  on public.api_keys for all
  using (auth.uid() = user_id);

-- ── Usage tracking ───────────────────────────────────────────────────────

create table if not exists public.usage_log (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles,  -- null for anonymous
  video_id text not null,
  comments_count integer not null,
  spoilers_found integer not null default 0,
  processing_ms integer,
  created_at timestamptz not null default now()
);

-- Index for daily usage queries
create index if not exists idx_usage_user_date
  on public.usage_log (user_id, created_at);

alter table public.usage_log enable row level security;

create policy "Users can read own usage"
  on public.usage_log for select
  using (auth.uid() = user_id);

-- ─��� Daily request counter reset function ─────────────────────────────────

create or replace function public.increment_usage(p_user_id uuid)
returns integer as $$
declare
  v_count integer;
begin
  -- Reset counter if it's a new day
  update public.profiles
  set requests_today = 0, requests_reset_at = now()
  where id = p_user_id
    and requests_reset_at < current_date;

  -- Increment and return new count
  update public.profiles
  set requests_today = requests_today + 1, updated_at = now()
  where id = p_user_id
  returning requests_today into v_count;

  return v_count;
end;
$$ language plpgsql security definer;
