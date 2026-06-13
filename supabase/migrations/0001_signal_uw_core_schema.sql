-- Signal UW core schema (Master Build Spec v1.0, Section 4)
-- Applied to Supabase project nmguadctlkhunkfhfimb on 2026-06-10.
-- All tables in public schema. UUID PKs via gen_random_uuid().

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null, -- nullable for anon
  address_raw text,
  address_formatted text,
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  current_step integer check (current_step between 1 and 8),
  error_step integer,
  error_message text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create table public.subject_properties (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  address text,
  lat double precision,
  lng double precision,
  sqft integer,
  beds integer,
  baths double precision,
  year_built integer,
  lot_size_acres double precision,
  garage integer, -- number of doors
  pool boolean,
  property_type text,
  raw_json jsonb, -- full Rentcast response
  created_at timestamptz not null default now()
);

create table public.avm_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  avm_type text not null check (avm_type in ('rent','sale')),
  estimate double precision,
  range_low double precision,
  range_high double precision,
  comps_json jsonb,
  created_at timestamptz not null default now()
);

create table public.comp_scores (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  avm_type text not null check (avm_type in ('rent','sale')),
  comp_address text,
  comp_json jsonb,
  sqft_score double precision,
  distance_score double precision,
  yearbuilt_score double precision,
  lotsize_score double precision,
  garage_score double precision,
  pool_score double precision,
  bedbath_score double precision,
  similarity_score double precision,
  created_at timestamptz not null default now()
);

create table public.ai_comp_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  avm_type text not null check (avm_type in ('rent','sale')),
  final_comps_json jsonb, -- 5 final comps
  excluded_high_json jsonb,
  excluded_low_json jsonb,
  created_at timestamptz not null default now()
);

create table public.underwriting_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  arv double precision,
  estimated_rent double precision,
  sale_comps_json jsonb,
  rent_comps_json jsonb,
  created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  email text,
  address text,
  created_at timestamptz not null default now()
);

create table public.underwritings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  address text,
  report_json jsonb,
  verdict text check (verdict in ('Buy','Pass','Review')),
  created_at timestamptz not null default now()
);

create table public.user_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  base_credits integer not null default 0,
  referral_credits integer not null default 0,
  credits_used_this_month integer not null default 0,
  last_reset_date timestamptz
);

create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid references auth.users(id) on delete cascade,
  referred_email text,
  sent_at timestamptz not null default now(),
  opened_at timestamptz,
  signed_up_at timestamptz,
  credits_awarded integer not null default 0
);

create table public.debug_log (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references public.jobs(id) on delete cascade,
  step integer,
  function_name text,
  status text check (status in ('pass','fail')),
  input_payload jsonb,
  output_payload jsonb,
  error_message text,
  duration_ms integer,
  created_at timestamptz not null default now()
);

-- Indexes on foreign keys and common lookups
create index idx_jobs_user_id on public.jobs(user_id);
create index idx_jobs_status on public.jobs(status);
create index idx_subject_properties_job_id on public.subject_properties(job_id);
create index idx_avm_results_job_id on public.avm_results(job_id);
create index idx_comp_scores_job_id on public.comp_scores(job_id);
create index idx_comp_scores_job_avm_score on public.comp_scores(job_id, avm_type, similarity_score desc);
create index idx_ai_comp_results_job_id on public.ai_comp_results(job_id);
create index idx_underwriting_results_job_id on public.underwriting_results(job_id);
create index idx_underwritings_user_id on public.underwritings(user_id);
create index idx_underwritings_job_id on public.underwritings(job_id);
create index idx_leads_email on public.leads(email);
create index idx_referrals_referrer_user_id on public.referrals(referrer_user_id);
create index idx_debug_log_job_id on public.debug_log(job_id);
create index idx_debug_log_job_created on public.debug_log(job_id, created_at);
