-- Signal UW — owner notifications + admin stats (phase: usage tracking)
-- Adds:
--   1. pg_net (outbound HTTP from Postgres) + a notify helper that reads its
--      target URL + shared secret from Vault (so no secrets live in git).
--   2. AFTER INSERT triggers on public.leads (email capture / "test it out")
--      and auth.users (new Google signup) that ping the notify-owner edge fn.
--   3. public.admin_overview(days) — one SECURITY DEFINER function returning all
--      backend usage metrics as jsonb, for the owner-only dashboard.
--
-- Security model (matches 0002): all reads here go through the service role via
-- the admin-stats edge function. Nothing new is exposed to anon/authenticated.

-- ---- 1. Outbound HTTP ----
create extension if not exists pg_net;

-- Helper: POST {event, data} to the notify-owner edge function.
-- URL + secret come from Vault entries 'notify_url' and 'notify_secret'
-- (added once via the dashboard — see docs/usage-tracking-setup.md).
create or replace function public.notify_owner(p_event text, p_data jsonb)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_url    text;
  v_secret text;
begin
  select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'notify_url';
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'notify_secret';

  -- If Vault isn't configured yet, no-op rather than failing the INSERT.
  if v_url is null then
    return;
  end if;

  perform net.http_post(
    url     := v_url,
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-notify-secret', coalesce(v_secret, '')
               ),
    body    := jsonb_build_object('event', p_event, 'data', p_data)
  );
exception when others then
  -- Never let a notification failure block the signup / lead insert.
  raise warning 'notify_owner failed: %', sqlerrm;
end;
$$;

revoke all on function public.notify_owner(text, jsonb) from public;

-- ---- 2. Triggers ----

-- Email capture on the homepage ("test it out").
create or replace function public.tg_notify_new_lead()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.notify_owner(
    'lead',
    jsonb_build_object(
      'email', new.email,
      'address', new.address,
      'created_at', new.created_at
    )
  );
  return new;
end;
$$;

drop trigger if exists notify_new_lead on public.leads;
create trigger notify_new_lead
  after insert on public.leads
  for each row execute function public.tg_notify_new_lead();

-- New signup (Google OAuth lands a row in auth.users).
create or replace function public.tg_notify_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  perform public.notify_owner(
    'signup',
    jsonb_build_object(
      'user_id', new.id,
      'email', new.email,
      'provider', coalesce(new.raw_app_meta_data->>'provider', 'unknown'),
      'created_at', new.created_at
    )
  );
  return new;
end;
$$;

drop trigger if exists notify_new_user on auth.users;
create trigger notify_new_user
  after insert on auth.users
  for each row execute function public.tg_notify_new_user();

-- ---- 3. Admin overview metrics ----
-- Returns everything the dashboard needs in one round trip. Called only by the
-- admin-stats edge function (service role). p_days bounds the "recent" windows.
create or replace function public.admin_overview(p_days int default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_since timestamptz := now() - make_interval(days => greatest(p_days, 1));
  v_today date := (now() at time zone 'utc')::date;
  result jsonb;
begin
  result := jsonb_build_object(
    'generated_at', now(),
    'window_days', p_days,

    -- Users
    'users_total',        (select count(*) from auth.users),
    'users_new_in_window',(select count(*) from auth.users where created_at >= v_since),
    'users_new_today',    (select count(*) from auth.users where created_at::date = v_today),

    -- Email capture / demo interest (leads)
    'leads_total',         (select count(*) from public.leads),
    'leads_in_window',     (select count(*) from public.leads where created_at >= v_since),
    'leads_today',         (select count(*) from public.leads where created_at::date = v_today),

    -- Activity: underwrites run (the core product action)
    'reports_total',       (select count(*) from public.underwritings),
    'reports_in_window',   (select count(*) from public.underwritings where created_at >= v_since),
    'reports_today',       (select count(*) from public.underwritings where created_at::date = v_today),
    'reports_by_verdict',  (select coalesce(jsonb_object_agg(verdict, c), '{}'::jsonb)
                              from (select coalesce(verdict,'Unknown') verdict, count(*) c
                                    from public.underwritings where created_at >= v_since
                                    group by 1) s),

    -- Jobs (includes anonymous demo runs with null user_id) + failure rate
    'jobs_in_window',      (select count(*) from public.jobs where created_at >= v_since),
    'jobs_failed_in_window',(select count(*) from public.jobs where created_at >= v_since and status = 'failed'),
    'anon_jobs_in_window', (select count(*) from public.jobs where created_at >= v_since and user_id is null),

    -- Conversion
    'paying_subscribers',  (select count(*) from public.subscriptions where status in ('active','trialing','past_due')),
    'subs_by_plan',        (select coalesce(jsonb_object_agg(plan_key, c), '{}'::jsonb)
                              from (select plan_key, count(*) c from public.subscriptions
                                    where status in ('active','trialing','past_due')
                                    group by 1) s),

    -- Daily signup trend for the window (for a sparkline/bar chart)
    'signups_by_day',      (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'count', c) order by d), '[]'::jsonb)
                              from (select created_at::date d, count(*) c from auth.users
                                    where created_at >= v_since group by 1) s),
    'reports_by_day',      (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'count', c) order by d), '[]'::jsonb)
                              from (select created_at::date d, count(*) c from public.underwritings
                                    where created_at >= v_since group by 1) s),

    -- Most recent signups + leads (for an activity feed)
    'recent_signups',      (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'at', created_at) order by created_at desc), '[]'::jsonb)
                              from (select email, created_at from auth.users order by created_at desc limit 15) s),
    'recent_leads',        (select coalesce(jsonb_agg(jsonb_build_object('email', email, 'address', address, 'at', created_at) order by created_at desc), '[]'::jsonb)
                              from (select email, address, created_at from public.leads order by created_at desc limit 15) s)
  );
  return result;
end;
$$;

revoke all on function public.admin_overview(int) from public, anon, authenticated;
grant execute on function public.admin_overview(int) to service_role;
