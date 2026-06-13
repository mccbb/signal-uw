-- Step 8 assembles the full caller-facing report (arv, ranges, comps, quality,
-- notes). Store it as the single source of truth for the GET return + history.
-- (Applied 2026-06-11.)
alter table public.underwriting_results
  add column if not exists report_json jsonb;
