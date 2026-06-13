# Signal UW — Supabase backend

Project ref: `nmguadctlkhunkfhfimb`
API URL: `https://nmguadctlkhunkfhfimb.supabase.co`
Region: us-east-1 · Postgres 17

## What's built (Phase 1 — Database schema)

All 11 tables from Master Build Spec §4 are live, with RLS, grants, indexes, and
constraints. Migrations are recorded in `migrations/` and were applied directly to
the project.

| Table | Purpose | Client API access |
|---|---|---|
| `jobs` | Job lifecycle / progress (steps 1–8) | none (edge fn only) |
| `subject_properties` | Rentcast subject record | none |
| `avm_results` | Rent + sale AVM pulls | none |
| `comp_scores` | Per-comp similarity scores (step 6) | none |
| `ai_comp_results` | Step 7 AI-refined 5 comps | none |
| `underwriting_results` | Final ARV + rent (step 8) | none |
| `leads` | Anonymous trial email capture | none |
| `underwritings` | User report history | own rows (authenticated) |
| `user_credits` | Base + referral credit balances | own rows (authenticated) |
| `referrals` | Referral tracking + awards | own rows (authenticated) |
| `debug_log` | Mandatory per-step trace | none |

## Security model

The `/underwrite` edge function uses the **service-role key**, which bypasses RLS
and grants — that's how the engine writes to every table. The public API surface
(anon + authenticated roles) is locked down:

- Engine-internal tables: `SELECT` revoked from anon + authenticated. Not in the
  PostgREST/GraphQL surface at all. RLS on as deny-by-default.
- Client-facing tables (`underwritings`, `user_credits`, `referrals`): readable
  only by the signed-in owner via RLS row-scoping; anon has no access.

Job-status polling and report retrieval are intended to go through edge-function
endpoints (service role), not direct table reads — works for anonymous trial users
who have no `auth.uid()`.

## Verification (2026-06-10)

11 tables · 95 columns · 11 foreign keys · 42 check constraints · 26 indexes · 3 RLS policies.
Security advisors: remaining lints are intentional — `rls_enabled_no_policy` (INFO)
on internal tables is deny-by-default; `authenticated` discoverability warnings on
the 3 client tables are by design (RLS scopes rows per user).

## Next phases (not yet built)

1. `/underwrite` edge function — jobs-table pattern, steps 1–8 (mocked APIs first).
2. `/history` edge function for MCP retrieval.
3. `signal-mcp` manifest (`underwrite_property` tool).
4. `signal-frontend` (Lovable) — pages + homepage chat flow.
