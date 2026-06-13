-- Signal UW — RLS + API surface (applied 2026-06-10)
-- Security model: the /underwrite edge function uses the service-role key, which
-- bypasses both RLS and table grants. So ALL engine writes happen via service role.
-- Below we lock the public (anon/authenticated) API surface to the minimum.

-- ---- Enable RLS on every table ----
alter table public.jobs enable row level security;
alter table public.subject_properties enable row level security;
alter table public.avm_results enable row level security;
alter table public.comp_scores enable row level security;
alter table public.ai_comp_results enable row level security;
alter table public.underwriting_results enable row level security;
alter table public.leads enable row level security;
alter table public.underwritings enable row level security;
alter table public.user_credits enable row level security;
alter table public.referrals enable row level security;
alter table public.debug_log enable row level security;

-- ---- Engine-internal tables: remove from public API entirely ----
-- Only the edge function (service role) reads/writes these. Revoke SELECT from
-- anon + authenticated; RLS stays on as deny-by-default defense in depth.
revoke select on public.jobs from anon, authenticated;
revoke select on public.subject_properties from anon, authenticated;
revoke select on public.avm_results from anon, authenticated;
revoke select on public.comp_scores from anon, authenticated;
revoke select on public.ai_comp_results from anon, authenticated;
revoke select on public.underwriting_results from anon, authenticated;
revoke select on public.debug_log from anon, authenticated;
revoke select on public.leads from anon, authenticated;

-- ---- Client-facing tables: signed-in users read only their own rows ----
-- anon has no access; authenticated is row-scoped via RLS.
revoke select on public.underwritings from anon;
revoke select on public.user_credits from anon;
revoke select on public.referrals from anon;

create policy "underwritings_select_own" on public.underwritings
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "user_credits_select_own" on public.user_credits
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy "referrals_select_own" on public.referrals
  for select to authenticated
  using (referrer_user_id = (select auth.uid()));

-- Note: jobs polling and all report retrieval go through edge-function endpoints
-- (service role), so jobs/results tables intentionally have no client policies.
