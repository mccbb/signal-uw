-- ============ PLANS (pricing source of truth for metering) ============
create table if not exists public.plans (
  plan_key text primary key,
  name text not null,
  monthly_inquiries int not null,
  monthly_price_cents int not null,
  overage_cents int,                 -- null = hard cap (no overage)
  mcp_access boolean not null default false,
  stripe_price_id text,              -- filled in once Stripe products exist
  sort int not null default 0
);

insert into public.plans (plan_key, name, monthly_inquiries, monthly_price_cents, overage_cents, mcp_access, sort) values
  ('casual','Casual',30,4900,null,false,1),
  ('investor','Investor',75,9900,null,true,2),
  ('institution','Institution',249,24900,100,true,3)
on conflict (plan_key) do update set
  name=excluded.name,
  monthly_inquiries=excluded.monthly_inquiries,
  monthly_price_cents=excluded.monthly_price_cents,
  overage_cents=excluded.overage_cents,
  mcp_access=excluded.mcp_access,
  sort=excluded.sort;

-- ============ STRIPE CUSTOMER MAP ============
create table if not exists public.stripe_customers (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null unique,
  created_at timestamptz not null default now()
);

-- ============ SUBSCRIPTIONS (one row per user; mirrored from Stripe) ============
create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text unique,
  plan_key text references public.plans(plan_key),
  status text not null default 'inactive',   -- active, trialing, past_due, canceled, inactive
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);

-- ============ OVERAGE LEDGER (Institution beyond limit; billed next invoice) ============
create table if not exists public.overage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  job_id uuid references public.jobs(id),
  units int not null default 1,
  unit_amount_cents int not null,
  period_start timestamptz,
  period_end timestamptz,
  reported_to_stripe boolean not null default false,
  stripe_invoice_item_id text,
  created_at timestamptz not null default now()
);
create index if not exists overage_events_unreported_idx
  on public.overage_events (stripe_customer_id) where reported_to_stripe = false;

-- ============ RLS ============
alter table public.plans enable row level security;
alter table public.stripe_customers enable row level security;
alter table public.subscriptions enable row level security;
alter table public.overage_events enable row level security;

drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select to anon, authenticated using (true);

drop policy if exists subs_read_own on public.subscriptions;
create policy subs_read_own on public.subscriptions for select to authenticated using (auth.uid() = user_id);

drop policy if exists overage_read_own on public.overage_events;
create policy overage_read_own on public.overage_events for select to authenticated using (auth.uid() = user_id);

drop policy if exists cust_read_own on public.stripe_customers;
create policy cust_read_own on public.stripe_customers for select to authenticated using (auth.uid() = user_id);
-- (no insert/update policies anywhere → only the service role writes these)

-- ============ METERING FUNCTIONS ============
create or replace function public.count_reports_in_window(p_user_id uuid, p_from timestamptz, p_to timestamptz)
returns int language sql security definer set search_path = public as $$
  select count(*)::int from public.underwritings
   where user_id = p_user_id and created_at >= p_from and created_at < p_to;
$$;

-- Called before every run to decide allow/deny + whether this run is overage.
create or replace function public.check_run_allowance(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
  v_used int;
  v_trial_used int;
  v_trial_limit int := 2;
begin
  select * into v_sub from public.subscriptions
   where user_id = p_user_id and status in ('active','trialing');

  if found and v_sub.plan_key is not null then
    select * into v_plan from public.plans where plan_key = v_sub.plan_key;
    v_used := public.count_reports_in_window(
      p_user_id,
      coalesce(v_sub.current_period_start, now()),
      coalesce(v_sub.current_period_end, now() + interval '100 years'));

    if v_used < v_plan.monthly_inquiries then
      return jsonb_build_object('allowed',true,'reason','within_plan','plan_key',v_plan.plan_key,
        'used',v_used,'inquiry_limit',v_plan.monthly_inquiries,'is_overage',false,
        'period_start',v_sub.current_period_start,'period_end',v_sub.current_period_end,
        'overage_cents',v_plan.overage_cents);
    elsif v_plan.overage_cents is not null then
      return jsonb_build_object('allowed',true,'reason','overage','plan_key',v_plan.plan_key,
        'used',v_used,'inquiry_limit',v_plan.monthly_inquiries,'is_overage',true,
        'period_start',v_sub.current_period_start,'period_end',v_sub.current_period_end,
        'overage_cents',v_plan.overage_cents);
    else
      return jsonb_build_object('allowed',false,'reason','limit_reached','plan_key',v_plan.plan_key,
        'used',v_used,'inquiry_limit',v_plan.monthly_inquiries,'is_overage',false,
        'period_end',v_sub.current_period_end);
    end if;
  end if;

  -- No active subscription → lifetime free trial.
  v_trial_used := (select count(*)::int from public.underwritings where user_id = p_user_id);
  if v_trial_used < v_trial_limit then
    return jsonb_build_object('allowed',true,'reason','trial','plan_key','trial',
      'used',v_trial_used,'inquiry_limit',v_trial_limit,'is_overage',false);
  else
    return jsonb_build_object('allowed',false,'reason','trial_exhausted','plan_key','trial',
      'used',v_trial_used,'inquiry_limit',v_trial_limit,'is_overage',false);
  end if;
end;
$$;

-- Billing status for the account/paywall UI.
create or replace function public.get_billing_status(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub public.subscriptions;
  v_plan public.plans;
  v_used int;
  v_overage_units int;
  v_trial_used int;
begin
  select * into v_sub from public.subscriptions where user_id = p_user_id;
  if found and v_sub.status in ('active','trialing','past_due') and v_sub.plan_key is not null then
    select * into v_plan from public.plans where plan_key = v_sub.plan_key;
    v_used := public.count_reports_in_window(
      p_user_id,
      coalesce(v_sub.current_period_start, now()),
      coalesce(v_sub.current_period_end, now()));
    v_overage_units := greatest(0, v_used - v_plan.monthly_inquiries);
    return jsonb_build_object(
      'status', v_sub.status, 'plan_key', v_plan.plan_key, 'plan_name', v_plan.name,
      'inquiry_limit', v_plan.monthly_inquiries, 'used', v_used,
      'remaining', greatest(0, v_plan.monthly_inquiries - v_used),
      'overage_units', v_overage_units, 'overage_cents', v_plan.overage_cents,
      'mcp_access', v_plan.mcp_access, 'cancel_at_period_end', v_sub.cancel_at_period_end,
      'period_start', v_sub.current_period_start, 'period_end', v_sub.current_period_end,
      'is_trial', false);
  end if;
  v_trial_used := (select count(*)::int from public.underwritings where user_id = p_user_id);
  return jsonb_build_object('status','trial','plan_key',null,'plan_name','Free trial',
    'inquiry_limit',2,'used',v_trial_used,'remaining',greatest(0,2 - v_trial_used),
    'overage_units',0,'overage_cents',null,'mcp_access',false,
    'cancel_at_period_end',false,'is_trial',true);
end;
$$;

-- Record one overage unit for a completed overage run.
create or replace function public.record_overage(p_user_id uuid, p_job_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_sub public.subscriptions; v_plan public.plans;
begin
  select * into v_sub from public.subscriptions where user_id = p_user_id and status in ('active','trialing');
  if not found then return; end if;
  select * into v_plan from public.plans where plan_key = v_sub.plan_key;
  if v_plan.overage_cents is null then return; end if;
  insert into public.overage_events(user_id, stripe_customer_id, stripe_subscription_id, job_id,
    units, unit_amount_cents, period_start, period_end)
  values (p_user_id, v_sub.stripe_customer_id, v_sub.stripe_subscription_id, p_job_id,
    1, v_plan.overage_cents, v_sub.current_period_start, v_sub.current_period_end);
end;
$$;

grant execute on function public.count_reports_in_window(uuid, timestamptz, timestamptz) to service_role;
grant execute on function public.check_run_allowance(uuid) to service_role;
grant execute on function public.get_billing_status(uuid) to service_role;
grant execute on function public.record_overage(uuid, uuid) to service_role;
