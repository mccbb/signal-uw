-- Per-user API keys (MCP identity) + per-user history/cache key. (Applied 2026-06-11.)
create extension if not exists pgcrypto with schema extensions;

-- We store only a SHA-256 hash of each key, plus a short prefix for display.
-- The raw key is shown once at creation and never stored.
create table public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key_hash text not null unique,
  key_prefix text,
  label text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked boolean not null default false
);
create index idx_api_keys_hash on public.api_keys(key_hash) where revoked = false;
create index idx_api_keys_user on public.api_keys(user_id);

alter table public.api_keys enable row level security;
revoke select on public.api_keys from anon, authenticated;

-- Normalized raw address powers the 7-day per-user cache (no re-geocoding).
alter table public.underwritings add column if not exists address_key text;
create index if not exists idx_underwritings_user_addr
  on public.underwritings(user_id, address_key, created_at desc);

-- Mint a key for a user; returns the raw key ONCE. Service role only.
--   select public.mint_api_key('<user uuid>', 'My MCP key');
create or replace function public.mint_api_key(p_user_id uuid, p_label text default null)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_key text;
begin
  raw_key := 'sgl_' || encode(extensions.gen_random_bytes(24), 'hex');
  insert into public.api_keys (user_id, key_hash, key_prefix, label)
  values (p_user_id, encode(extensions.digest(raw_key, 'sha256'), 'hex'), left(raw_key, 12), p_label);
  return raw_key;
end;
$$;
revoke all on function public.mint_api_key(uuid, text) from public, anon, authenticated;
grant execute on function public.mint_api_key(uuid, text) to service_role;
