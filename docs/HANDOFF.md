# Signal UW — Engineering Handoff (for a fresh Cowork thread)

**Last updated:** 2026-06-12. This file is the single source of truth for picking
up the build. Read it top to bottom before doing anything.

---

## 0. Your first actions in this new thread (what the owner asked for)

1. **Switch Stripe to TEST mode**, then **archive all the old/leftover products**,
   then **create the 3 correct products + monthly prices** (Casual/Investor/
   Institution). Details + IDs in §8.
2. Then continue the roadmap in §13 through to launch.

Before any Stripe *write*, confirm the Stripe MCP is in **test mode** by reading
a product/price and checking `"livemode": false`. The connection was LIVE when
this handoff was written — the owner is reconnecting it with a **test key**. Do
not create/modify anything until a read shows `livemode:false`.

Creating products/prices and archiving products are account-configuration
changes — the owner has pre-authorized these specific Stripe actions (switch to
test, archive old, build new). Still surface anything destructive or unexpected.

---

## 1. What Signal is

AI-powered real-estate **underwriting API for investors**. Input: a US street
address. Output: **ARV (after-repair value), estimated monthly rent, value
ranges, and the comparable properties used** (flip/rental investing — NOT
insurance, NOT risk/flood/crime).

**Core architecture principle (do not violate):** *Signal is the engine. Every
surface — website chat, MCP, future API — calls the same single `/underwrite`
endpoint.* No business logic lives anywhere but the engine.

---

## 2. Status snapshot

**Live and verified:**
- Full 8-step underwriting engine (`underwrite` edge function) — runs live.
- Billing/metering database layer (tables + 4 SQL functions) — verified across
  every branch (trial / within-plan / overage / hard-cap) via a rollback test.
- `stripe-billing` and `stripe-webhook` edge functions — deployed (await secrets).
- `keys` edge function (MCP API-key mint/list/revoke) — deployed.
- `plans` table seeded with the correct pricing (price IDs still null).
- `live_guard` cost failsafe: cap **500** runs, used 0, hard_stop off.

**Built but NOT yet deployed (CRITICAL — see §9):**
- The metering wiring inside the engine (`pipeline.ts` + `lib/db.ts`). The live
  `underwrite` is **v17 and still uses the old "2 lifetime free reports" logic**.
  Until it's redeployed, **paid subscribers would be wrongly capped at 2 reports.**
  This MUST be redeployed before anyone subscribes.

**Not started:** Stripe products in test mode (your job 1), website wiring to the
engine, Google OAuth, logged-in app pages (dashboard/history/billing/downloads).

**Counts right now:** 0 subscriptions, 0 stripe_customers, 0 underwritings (clean).

---

## 3. Infrastructure & credentials

- **Supabase project:** `nmguadctlkhunkfhfimb`
  - URL: `https://nmguadctlkhunkfhfimb.supabase.co`
  - Publishable (anon) key (browser-safe): `sb_publishable_s2huboLvjn2np4XfzP6RVA_2B57s9BI`
  - Access via the **Supabase MCP** (project `nmguadctlkhunkfhfimb`): `execute_sql`,
    `apply_migration`, `deploy_edge_function`, `list_edge_functions`, `get_logs`, etc.
- **Stripe** via the **Stripe MCP** (`stripe_api_read/write/search/details`,
  `fetch_stripe_resources`). Was LIVE; owner is reconnecting in TEST.
- **Claude in Chrome** MCP available (to view/drive the bolt.host site).
- **Sandbox shell** has NO network to supabase.co / api.supabase.com (allowlist
  blocked) and no Supabase CLI/token. So **all deploys go through the Supabase MCP**,
  not the CLI.

### Edge-function secrets (set in Supabase dashboard → Edge Functions → Secrets)
Already set (engine works live): `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
`SUPABASE_ANON_KEY`, `GOOGLE_MAPS_API_KEY`, `RENTCAST_API_KEY`,
`ANTHROPIC_API_KEY`, `MOCK_EXTERNAL=false` (false = real external calls).

**Still needed for Stripe (owner must add — there's no MCP tool to set secrets):**
- `STRIPE_SECRET_KEY` — use the **test** key (`sk_test_…`) while in test mode;
  swap to `sk_live_…` at launch.
- `STRIPE_WEBHOOK_SECRET` — `whsec_…` from the webhook endpoint you create (§8.4).
- `SITE_URL` — `https://signal-underwriting-c294.bolt.host` (optional; used for
  checkout success/cancel + portal return).

⚠️ Never put the service-role key or any provider key (Stripe secret, Google,
RentCast, Anthropic) in the browser. The browser only ever uses the publishable
key + the signed-in user's session token.

---

## 4. Database (Supabase Postgres)

Migrations live in `supabase/migrations/0001…0007*.sql`, all applied.

### Engine tables (don't change without reason)
`jobs`, `subject_properties`, `avm_results`, `comp_scores`, `ai_comp_results`,
`underwriting_results`, `underwritings` (per-user permanent history + powers the
7-day cache), `debug_log` (mandatory per-step log), `live_guard` (cost breaker),
`api_keys` (SHA-256-hashed Signal API keys for MCP).

### Billing tables (migration 0007 — new this phase)
- **`plans`** (pricing source of truth). Seeded:
  | plan_key | name | monthly_inquiries | price_cents | overage_cents | mcp_access | stripe_price_id |
  |---|---|---|---|---|---|---|
  | casual | Casual | 30 | 4900 | null | false | **null → set in §8** |
  | investor | Investor | 75 | 9900 | null | true | **null → set in §8** |
  | institution | Institution | 249 | 24900 | 100 | true | **null → set in §8** |
- **`stripe_customers`** — `user_id ↔ stripe_customer_id`.
- **`subscriptions`** — one row per user: `plan_key, status, stripe_customer_id,
  stripe_subscription_id, current_period_start/end, cancel_at_period_end`. Written
  only by the webhook.
- **`overage_events`** — one row per Institution run past 249: `units,
  unit_amount_cents (100), period_*, reported_to_stripe, stripe_invoice_item_id`.

RLS: enabled on all; users can SELECT only their own subscription/overage/customer
rows; `plans` is world-readable. Only the **service role** writes these.

### Metering SQL functions (SECURITY DEFINER) — all live & verified
- `check_run_allowance(p_user_id) → jsonb` — call before each run. Returns
  `{allowed, reason, plan_key, used, inquiry_limit, is_overage, period_start,
  period_end, overage_cents}`. `reason ∈ within_plan | overage | limit_reached |
  trial | trial_exhausted`.
- `get_billing_status(p_user_id) → jsonb` — for the account/paywall UI
  (`status, plan_name, used, remaining, overage_units, period_end, is_trial, …`).
- `record_overage(p_user_id, p_job_id)` — logs one $1.00 overage unit.
- `count_reports_in_window(p_user_id, from, to) → int`.

**Verified behavior (rollback test, zero cost):** trial 0→allowed; trial ≥2→
`trial_exhausted`; overage plan past limit→allowed+`is_overage` + overage_event
logged; billing status shows `overage_units`; no-overage plan past limit→
`limit_reached`.

---

## 5. Edge functions (current versions)

| slug | ver | verify_jwt | purpose |
|---|---|---|---|
| `underwrite` | **17** | true | The engine. **v17 lacks metering — must redeploy (§9).** |
| `keys` | 1 | false* | Mint/list/revoke Signal API keys (MCP). *uses session bearer internally |
| `stripe-billing` | 1 | true | GET billing status; POST `{action:"checkout",plan_key}` / `{action:"portal"}` |
| `stripe-webhook` | 1 | false | Stripe events → sync `subscriptions`, bill overage as invoice items |
| `check-user` | 1 | true | **Bolt-created.** Review/remove — see §6 reconciliation |
| `increment-query` | 1 | true | **Bolt-created.** Likely a parallel trial counter — see §6 |

URLs: `https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/<slug>`
(e.g. webhook = `…/functions/v1/stripe-webhook`).

---

## 6. ⚠️ Bolt-created functions to reconcile

Bolt's Supabase integration deployed `check-user` and `increment-query`, and the
schema has empty `user_credits` / `user_trials` tables from an earlier scaffold.
These imply Bolt may be doing its **own** query-counting/trial gating on the
client side, which would **bypass the engine's metering** (the single-endpoint
principle). 

Action for the new thread: confirm the website calls **our** `/underwrite`
(which meters via `check_run_allowance`) and does NOT rely on `increment-query`/
`check-user` for limits. If they're redundant, plan to remove them. Don't delete
blindly — read their source (`get_edge_function`) first and check what the bolt
site calls (Chrome MCP / `read_network_requests`).

---

## 7. Metering & billing model (decisions locked by the owner)

- **A credit = one completed report.** Cached repeats (same address, 7-day,
  per-user) and failed runs are **free**. (Implemented: cache returns before the
  gate; history row only written on success, and the gate counts history rows.)
- **Reset = Stripe billing cycle** (uses `subscription.current_period_start/end`).
  No cron needed — usage is counted within the live period window.
- **Overage = Institution only.** Past 249, runs are **allowed** and each logs a
  **$1.00** `overage_event`; billed on the **next invoice** as invoice items by
  the webhook (`invoice.created`, draft). Casual/Investor are **hard-capped**
  (→ `402 limit_reached`) until renewal/upgrade.
- **Non-subscribers:** 2 lifetime free reports, then `402 trial_exhausted`.
- **MCP/API access** is an Investor+ perk (`plans.mcp_access`). NOT yet enforced
  on the API-key path — optional hardening later.

---

## 8. Stripe setup (YOUR JOB 1 — do in TEST mode)

### 8.1 Confirm test mode
Read any product/price; ensure `livemode:false`. If you still see `livemode:true`,
stop and tell the owner to reconnect Stripe with a **test** key.

### 8.2 Archive the old products
In whatever mode you're in, `GetProducts` then archive every product that isn't
one of the 3 correct ones (set `active:false` via `PostProductsProduct`). For
reference, the **LIVE-mode** leftovers seen on 2026-06-12 were:
`prod_USPlIpGS42yZB6` (Signal Pro quarterly), `prod_USPf1nsCcRnHR5` (Bundle 50),
`prod_USPet2uZjwJOhe` (Pay As You Go), `prod_UJPQ1uqtCClsSY` (Starter Annual),
`prod_UJPQuXkl63lCDI` (Institution 250), `prod_UJPIxXzutR6Yqr` (Pro 75),
`prod_UJPIZ0jcTxU28L` (Starter 20). **Test mode will have its own/none — list and
archive whatever exists there.**

### 8.3 Create the 3 correct products + monthly prices
Use `PostProducts` then `PostPrices` (or product with `default_price_data`):
- **Signal Casual** — recurring **$49.00/mo** → `unit_amount: 4900`, `currency: usd`,
  `recurring.interval: month`.
- **Signal Investor** — recurring **$99.00/mo** → `unit_amount: 9900`.
- **Signal Institution** — recurring **$249.00/mo** → `unit_amount: 24900`.
- **Overage:** no product needed — billed as ad-hoc $1.00 invoice items by the webhook.
- (Enterprise "Custom Underwriting Agents" = sales/"Schedule a Call", no Stripe price.)

### 8.4 Wire price IDs into the DB
After creating, record each `price_…` id and run:
```sql
update public.plans set stripe_price_id = 'price_CASUAL'      where plan_key='casual';
update public.plans set stripe_price_id = 'price_INVESTOR'    where plan_key='investor';
update public.plans set stripe_price_id = 'price_INSTITUTION' where plan_key='institution';
```

### 8.5 Create the webhook endpoint
`PostWebhookEndpoints` → url
`https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/stripe-webhook`,
enabled events: `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.created`.
Take the returned **signing secret** → owner adds it as `STRIPE_WEBHOOK_SECRET`.
Owner also adds the test `STRIPE_SECRET_KEY` and `SITE_URL`.

### 8.6 End-to-end test (test mode, no real money, minimal engine cost)
- Hit `stripe-billing` POST `{action:"checkout", plan_key:"casual"}` with a test
  user's session token → open the returned URL → pay with `4242 4242 4242 4242`.
- Confirm the webhook wrote a `subscriptions` row (status active, period dates).
- Confirm `check_run_allowance` now returns the plan (use the SQL rollback-test
  pattern in §4 to avoid running real underwrites, which cost ~$0.35 each since
  `MOCK_EXTERNAL=false`).
- For overage: insert a test `subscriptions` row + enough `underwritings` rows in
  a rolled-back transaction (see the verified test), or trust the §4 result.

---

## 9. ⚠️ CRITICAL: redeploy the `underwrite` function with metering

The metering wiring is written on disk but **not deployed**. Changed files vs the
live v17: **`pipeline.ts`** (calls `checkRunAllowance`, returns `trial_exhausted`/
`limit_reached`, passes `isOverage`, calls `recordOverage` on success) and
**`lib/db.ts`** (adds `checkRunAllowance` + `recordOverage`; removed the old
`FREE_TRIAL_LIMIT`/`countUserUnderwritings` gate usage).

**How to deploy:** Supabase MCP `deploy_edge_function`, name `underwrite`,
`verify_jwt: true`, **including the COMPLETE file set** (omitting any file breaks
the bundle with "Module not found"). The 17 files (all present + correct on disk
at `supabase/functions/underwrite/`):
`index.ts, pipeline.ts, lib/anthropic.ts, lib/auth.ts, lib/db.ts, lib/errors.ts,
lib/google.ts, lib/rentcast.ts, lib/scoring.ts, steps/step1_accept_address.ts …
steps/step8_calculate_results.ts`.

Why it wasn't done in the prior thread: the MCP deploy requires inlining all file
contents (~90KB) in one call, and the sandbox has no network/CLI to deploy from
disk. A fresh thread with full output budget can emit it. **After deploying:**
1. `get_edge_function` and confirm `pipeline.ts` contains `checkRunAllowance` and
   `lib/db.ts` contains `export async function checkRunAllowance`, and that
   `lib/scoring.ts` (6609 chars) + `lib/anthropic.ts` (7653 chars) are unchanged
   in length (guards against transcription corruption of the money-critical math/
   prompt files).
2. Boot check: `GET …/underwrite?job_id=nope` → should return JSON `404 Job not
   found` (proves it compiled). A 500 module error means a file got mangled.
3. Do NOT run a real underwrite just to test (costs money + uses the 500 cap).

**Engine business rules that must never regress** (verify scoring/anthropic
untouched): spec scoring weights are renormalized (sqft .3261, distance .2717,
yearbuilt .2174, lotsize .1630, bedbath .0217; garage/pool dropped per owner);
hard cutoffs (sqft>500, dist>1mi, year>20, lot-tier mismatch); AI refine uses
`claude-sonnet-4-20250514`, temperature 0, max_tokens 1000, the exact spec prompt;
`enforceFinalFive` trims to exactly 5 comps; sparse-pool pullback + AVM fallback.

---

## 10. Website (built by owner in bolt.new)

Live: **https://signal-underwriting-c294.bolt.host** (single landing page + footer
Privacy/Terms links; dark, well-designed). Supabase is connected in Bolt.

**Problem:** copy is framed as *insurance* underwriting (flood/crime/coverage/
"Recommendation: Approved"). It must become *investor* ARV+rent+comps. The full,
section-by-section change list — **the one doc to paste into Bolt** — is:
`docs/signal-site-changes.md`. It covers: reframed hero/demo/how-it-works/
capabilities copy, the chat→engine wiring (with Google sign-in gating), MCP config
fix, and "keep the site's pricing" (Casual $49/30, Investor $99/75, Institution
$249/249 + $1.00 overage, Enterprise = Schedule a Call).

**Auth = Google only** (owner's decision). Sign-in required to run anything; 2 free
reports per account. Still TODO by owner: create the Google OAuth client (redirect
URI `https://nmguadctlkhunkfhfimb.supabase.co/auth/v1/callback`) and enable Google
(disable Email) in Supabase → Authentication → Providers.

**Engine responses the site must handle:** `202 {job_id}` (poll), `200 {…report,
cached:true}`, `401 {need_signin:true}`, `402 {trial_exhausted:true}` and
`402 {limit_reached:true, plan_key, inquiry_limit, period_end}`.

Report JSON shape: `{ status, address, arv, arv_range_low/high, estimated_rent,
rent_range_low/high, comps_analyzed, sale_comps[], rent_comps[] (each: address,
price_per_sqft, ai_notes), notes[], cached? }`.

Billing UI calls `stripe-billing`: GET for status/paywall, POST checkout/portal.

---

## 11. MCP server (for end-users' own Claude/ChatGPT)

`signal-mcp/` — stdio server, tools `underwrite_property` + `get_history`. Endpoint
+ publishable key baked in; user sets `SIGNAL_API_KEY` (minted via the `keys`
function). The site's MCP config block currently shows a fake `@signaluw/mcp-server`
npm package — fix to point at this real server (see §10 changes doc, item 7).

---

## 12. Repo map

Root: `C:\Users\mac\Code\signal-uw\` (sandbox: `/sessions/<id>/mnt/Code/signal-uw/`).
- `supabase/migrations/0001…0007*.sql` — schema (0007 = billing).
- `supabase/functions/underwrite/` — engine (index, pipeline, lib/*, steps/*).
- `supabase/functions/keys/index.ts`
- `supabase/functions/stripe-billing/index.ts`
- `supabase/functions/stripe-webhook/index.ts`
- `signal-mcp/` — index.mjs, package.json, README.md.
- `docs/signal-site-changes.md` — **the doc to give Bolt** (supersedes the two below).
- `docs/bolt-build-brief.md`, `docs/homepage-chat-wiring.md` — original from-scratch
  specs (kept for reference; updated to Google-only + 3-page + site pricing).
- `docs/HANDOFF.md` — this file.

---

## 13. Roadmap: now → completion

1. **Stripe (test):** confirm test mode → archive old → create 3 products+prices →
   write price IDs into `plans` (§8). Create webhook endpoint; owner adds the 3
   Stripe secrets.
2. **Redeploy `underwrite` with metering** (§9) + verify. *(Blocks paid usage.)*
3. **Reconcile Bolt's `check-user`/`increment-query`** so the site meters via the
   engine, not a parallel counter (§6).
4. **End-to-end test in test mode:** checkout → webhook → subscription row →
   allowance reflects plan → overage path (§8.6).
5. **Wire the website:** give Bolt `docs/signal-site-changes.md`; verify the chat
   calls `/underwrite` with the Google session token and renders the report card +
   paywall; billing page uses `stripe-billing`.
6. **Owner tasks:** Google OAuth client + enable Google provider; add Stripe secrets.
7. **Go live:** recreate the 3 products/prices + webhook in **live** mode, swap
   secrets to `sk_live_…`/live `whsec_…`, update `plans.stripe_price_id` to live
   prices. Sanity-check the 500-run `live_guard` cap before real traffic.
8. **Later (plan-first with owner):** logged-in app pages — Dashboard, History
   (`GET ?history=1`), Billing (portal), Downloads, Referral (table exists, unused).

---

## 14. Hard rules / guardrails (never break)

- **Never reveal data sources** to end users (no RentCast/Google/Zillow/MLS).
  Reports are "Signal's analysis." Naming "Claude/your AI" as the MCP client is fine.
- **No buy/pass/approve verdicts** — only ARV, rent, comps, ranges, notes.
- **AI never writes business logic** — engine math is deterministic; AI only refines comps.
- **Hard spend failsafe** stays on (`live_guard`, cap 500 ≈ a ~$175 ceiling;
  `hard_stop=true` kills all live runs). Never loop external calls.
- **Secrets**: hashed API keys only; never expose service-role/provider/Stripe keys
  in the browser.
- **Verify with zero cost** where possible (SQL rollback tests, cache hits) — real
  underwrites cost ~$0.35 and burn the live cap.

---

## 15. Open questions / not yet decided
- Whether to hard-enforce `mcp_access` (Investor+) on the API-key path.
- Referral credits mechanic (table exists, no logic yet).
- Final treatment of Bolt's `check-user`/`increment-query` (remove vs keep).
- Annual billing option? (Old Stripe had annual tiers; current model is monthly only.)
