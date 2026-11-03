-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run.

-- 1) One row ("main") holds the whole station: library, playlists, schedule, settings.
create table if not exists public.radio_state (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- 2) Listener song requests and dedications (only the admin can read them).
create table if not exists public.radio_messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  kind text not null,
  name text not null,
  text text not null
);

-- Lock both tables down: the browser never talks to Supabase directly.
-- Only the Vercel functions (using the service_role key) can read/write them.
alter table public.radio_state enable row level security;
alter table public.radio_messages enable row level security;
