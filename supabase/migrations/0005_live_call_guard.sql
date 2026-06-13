-- Cost failsafe / circuit breaker. Only consulted when MOCK_EXTERNAL=false.
-- A live underwrite consumes 1 from the budget at pipeline start; once the
-- budget is exhausted (or hard_stop is set), runs are blocked BEFORE any
-- external API call is made. (Applied 2026-06-11.)
create table public.live_guard (
  id int primary key default 1,
  max_live_runs int not null default 2,
  live_runs_used int not null default 0,
  hard_stop boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint live_guard_singleton check (id = 1)
);
insert into public.live_guard (id) values (1) on conflict (id) do nothing;

-- Service-role only; never exposed to the public API.
alter table public.live_guard enable row level security;
revoke select on public.live_guard from anon, authenticated;

-- Atomic guarded consume: increments only if under cap and not hard-stopped.
-- Returns true when the run is allowed, false when blocked.
create or replace function public.consume_live_run()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.live_guard
     set live_runs_used = live_runs_used + 1, updated_at = now()
   where id = 1 and hard_stop = false and live_runs_used < max_live_runs;
  return found;
end;
$$;

revoke all on function public.consume_live_run() from public, anon, authenticated;
grant execute on function public.consume_live_run() to service_role;

-- Operator controls (run as needed):
--   reset counter:        update public.live_guard set live_runs_used = 0;
--   raise cap:            update public.live_guard set max_live_runs = 1000;
--   instant kill switch:  update public.live_guard set hard_stop = true;
--   re-enable:            update public.live_guard set hard_stop = false;
