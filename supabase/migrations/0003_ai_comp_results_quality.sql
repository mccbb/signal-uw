-- Step 7 records a per-pool data-quality flag and transparency metadata so step 8
-- and the report can decide whether to fall back to the automated valuation
-- estimate and explain why the comps are imperfect. (Applied 2026-06-11.)
alter table public.ai_comp_results
  add column if not exists data_quality text check (data_quality in ('ok','low','none')),
  add column if not exists quality_meta jsonb;
