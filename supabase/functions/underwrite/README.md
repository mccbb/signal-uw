# /underwrite edge function

Deployed to project `nmguadctlkhunkfhfimb`, version 1, `verify_jwt = false`.
URL: `https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/underwrite`

Implements the jobs-table pattern (spec §3). **The full engine (steps 1–8) is
live.** POST an address → poll the job → GET returns the complete report when
`status=complete`.

## API

### Create — `POST /underwrite`
Body: `{ "address": "<free text US address>" }`

Returns `202`:
```json
{ "job_id": "uuid", "status": "queued" }
```
Engine runs in the background (`EdgeRuntime.waitUntil`). `400` if `address` is missing.

### Poll — `GET /underwrite?job_id=<uuid>`
Returns `200` with the job view (poll every ~2s until `status` is `complete` or `failed`):
```json
{
  "job_id": "uuid",
  "status": "queued | running | complete | failed",
  "current_step": 2,
  "address": "formatted or raw address",
  "error_step": null,
  "error_message": null,
  "created_at": "…",
  "completed_at": null
}
```
`404` if the job id is unknown.

## Steps implemented
- **Step 1 — `acceptAddress`** (`steps/step1_accept_address.ts`): trims/validates the raw string, logs `debug_log` step 1.
- **Step 2 — `validateAddress`** (`steps/step2_validate_address.ts`): Google geocoding. On no-result/error, halts the job (`status=failed`, `error_step=2`) and returns the spec's exact message: *"I couldn't verify that address. Can you double-check it and try again?"*
- **Step 3 — `getPropertyData`** (`steps/step3_get_property_data.ts`): RentCast `GET /properties`, maps the record → `subject_properties` and stores the full response in `raw_json`. Mapping highlights: `squareFootage→sqft`, `lotSize (sqft) → lot_size_acres` (÷43,560), `features.garageSpaces → garage` (doors), `features.pool → pool`, `propertyType → property_type`. Null required fields are logged as a warning in `missing_required_fields` but the job continues (spec). No record → `status=failed`, `error_step=3`.
- **Step 4 — `getAVMData`** (`steps/step4_get_avm_data.ts`): two RentCast calls — Rental AVM (`/avm/rent/long-term`) and Sale AVM (`/avm/value`), `compCount=25` (max allowable). Writes two `avm_results` rows (rent + sale) with `estimate`, `range_low`, `range_high`, and the full `comps_json` array. One `debug_log` step-4 row records both estimates + comp counts.
- **Step 5 — `confirmDataReady`** (`steps/step5_confirm_data_ready.ts`): internal gate, no external calls. Counts the `subject_properties` row and both `avm_results` rows (rent + sale); all must exist to proceed. Missing any → `status=failed`, `error_step=5`. Logs step-5 pass/fail with the counts.
- **Step 6 — `scoreComps`** (`steps/step6_score_comps.ts` + `lib/scoring.ts`): runs per pool (sale, rent). Applies the spec's hard cutoffs (sqft Δ>500, distance >1 mi, year Δ>20, lot-tier mismatch → excluded, similarity 0) then the weighted sub-scores. Stores every comp in `comp_scores`, sorts by `similarity_score` desc, passes the top 10 per pool to step 7. One `debug_log` row per pool (totals, excluded count, top-10).

  **Weight deviation (owner-approved):** RentCast AVM comps have no garage/pool, so those sub-scores (0.05 + 0.03) are dropped and the remaining five renormalized to sum to 1.0 — sqft 0.3261, distance 0.2717, year 0.2174, lot 0.1630, beds/baths 0.0217. `garage_score`/`pool_score` are stored `null`. All other formulas are verbatim from the spec. Missing subject/comp inputs yield a neutral 0.5 for that sub-score.

  **Edge case for steps 7–8:** a pool can legitimately return 0 surviving comps (all cut). Handled in step 7 below.
- **Step 7 — `refineComps`** (`steps/step7_refine_comps.ts` + `lib/anthropic.ts`): runs once per pool. Sends subject + top-10 comps to the model (`claude-sonnet-4-20250514`, max_tokens 1000, verbatim spec system prompt — never modified). The model weights each comp (0.5–1.5), computes `final_score = similarity × weight`, takes top 7, drops highest/lowest priced → 5 finals. Stored in `ai_comp_results` (final_comps_json, excluded_high/low_json). One `debug_log` row per pool.

  **Sparse-pool policy (owner-approved, beyond the spec):** if a pool has fewer than 7 surviving comps, step 7 flags `data_quality='low'`, **pulls back** the hard-cutoff-excluded comps (ranked by underlying similarity from the stored sub-scores) so the model still has a 10-comp pool, and sets `use_avm_fallback=true` so step 8 leads with the automated valuation estimate for that side. 0 comps total → skip the model call, `data_quality='none'`, fallback. The quality flag + pulled-back comps + fallback decision live in the new `ai_comp_results.data_quality` / `quality_meta` columns (migration 0003).

  **Owner override of spec §6 rule:** the spec says never substitute AVM numbers for comp-derived output; the AVM fallback above intentionally overrides that for thin-data cases. The data source is never named in any stored or user-facing field.
- **Step 8 — `calculateResults`** (`steps/step8_calculate_results.ts`): per pool, ARV/rent = mean price-per-sqft of the 5 final comps × subject sqft (spec). Range = the automated valuation's proportional spread re-centered on the point estimate (so the range always brackets the number); in the thin-data fallback case the headline value + range are the automated valuation estimate for that side. ARV rounded to $100, rent to $5. Stores `underwriting_results` (arv, estimated_rent, sale/rent_comps_json, and the full `report_json`), marks the job `complete`. Per spec §8, does NOT compute cap rate / DSCR / cash flow / verdict.

  `GET /underwrite?job_id=` returns `report_json` once complete: arv + range, estimated_rent + range, comps_analyzed, final_comps_used, sale_comps, rent_comps, per-side data_quality + method, and transparency notes (no source named).

Every step writes one `debug_log` row (input, output, status, duration_ms) — mandatory per spec §3.5.

> **Note for step 6 (similarity scoring):** RentCast AVM `comparables` do NOT
> include garage or pool fields (those come only from `/properties`). The spec's
> step-6 garage (5%) and pool (3%) sub-scores will need a decision then — e.g.
> neutral-score the missing fields, or enrich each comp via `/properties` (extra
> API calls). Flagged here so it isn't a surprise.

## Per-user features (MCP identity)

Callers identify themselves with a Signal API key in the `x-signal-api-key`
header. No key = anonymous (web trial, no cache/history). Keys are stored only as
a SHA-256 hash (`api_keys` table, migration 0006).

- **Mint a key (account page / admin):** `select public.mint_api_key('<user uuid>', 'label');` → returns the raw key once.
- **7-day per-user cache:** before running, if this user already underwrote this
  address (normalized) within 7 days, the saved report is returned (`cached: true`)
  with no engine run, no external calls, no budget consumed.
- **Permanent history:** every completed underwrite for an identified user is saved
  to `public.underwritings` (their drawer) — this is also what the cache reads.
- **History endpoint:** `GET /underwrite?history=1` with `x-signal-api-key` →
  `{ underwritings: [{ id, job_id, address, created_at, arv, estimated_rent }] }`.

AI determinism: step 7 runs the model at **temperature 0**, so the same comps
yield the same qualitative weights run-to-run.

Web-login identity (Supabase Auth) for the website surface is a later phase; the
engine already reads `x-signal-api-key`, so the MCP path works today.

## Secrets needed to go live
- `GOOGLE_GEOCODING_API_KEY` — step 2
- `RENTCAST_API_KEY` — step 3 (RentCast `X-Api-Key` header) and step 4 AVMs later
- `MOCK_EXTERNAL=false` — flips all external calls from mock to live

Set via Dashboard → Edge Functions → Secrets, or `supabase secrets set NAME=value --project-ref nmguadctlkhunkfhfimb`. Never set `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (auto-injected).

## Mocks vs. live (spec rule §6 — mock before going live)
External calls are **mocked by default**. The function reads `MOCK_EXTERNAL`:
- unset or anything except `"false"` → mock geocoder (deterministic, no key needed).
- `"false"` → real Google Geocoding; requires secret `GOOGLE_GEOCODING_API_KEY`.

The mock treats input containing `invalid`/`zzz`/`asdf`/`test-fail`, or shorter than
5 chars, as "no results" so the failure path is testable.

To go live later:
```
supabase secrets set GOOGLE_GEOCODING_API_KEY=... MOCK_EXTERNAL=false
```

## How it was tested (2026-06-10)
Because the build sandbox can't reach `*.supabase.co`, the live function was
exercised from inside Postgres via `pg_net` (`net.http_post`/`net.http_get`),
then DB state was verified with SQL. Results:

| Input | HTTP | jobs row | debug_log |
|---|---|---|---|
| `4821 Dunbar Ave, Birmingham, AL` | 202 + job_id | `running`, step 2, `address_formatted` set | step1 pass, step2 pass |
| `invalid` | 202 + job_id | `failed`, `error_step=2`, spec message | step1 pass, step2 fail |
| `{}` (no address) | 400 | — | — |
| GET poll (valid job) | 200 | returns job view | — |

To test from your machine (network-permitting):
```bash
curl -X POST https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/underwrite \
  -H "apikey: <anon key>" -H "Content-Type: application/json" \
  -d '{"address":"4821 Dunbar Ave, Birmingham, AL"}'
# then poll:
curl "https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/underwrite?job_id=<id>" \
  -H "apikey: <anon key>"
```

## Auth note
`verify_jwt=false` because anonymous free-trial calls (spec §7) and MCP API-key
callers (spec §8) must reach the endpoint. Per-caller auth (Signal API key →
`user_id` attribution, credit metering) is a dedicated later phase; today every
job is anonymous (`user_id = null`).

## Files
```
index.ts                      router + CORS
pipeline.ts                   jobs-table lifecycle + step orchestration
lib/db.ts                     service-role client, job helpers, logStep
lib/errors.ts                 StepError (carries step # + user message)
lib/google.ts                 geocode() — mock + live
steps/step1_accept_address.ts
steps/step2_validate_address.ts
```
