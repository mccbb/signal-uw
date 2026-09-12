# Dealroom — MVP Build Spec

**Brand:** The Comps (thecomps.co) · **Working name:** Dealroom
**Repo:** fork of `signal-uw` (this repo) · **Stack:** Supabase (Postgres + Edge Functions, project `nmguadctlkhunkfhfimb`), Lovable-generated React app in `/web`, Stripe (existing account, new product), GitHub Actions deploy.
**Builder:** Claude Sonnet 4.5 in Claude Code, working ticket-by-ticket from §8. Read `CLAUDE.md` at the repo root first.
**Owner:** Mac. Anything marked **OWNER** is done by Mac outside the repo (dashboard clicks, secrets).

---

## 0. What this is, in one paragraph

A wholesaler sends Mac a deal (text/email/whatever). Staff enter it in an admin screen and hit "Generate." The system runs the existing Signal engine against the address, assembles a **Dealroom** — the wholesaler's claims (preserved verbatim), property facts, a comps pool the investor can inspect and select from, an underwriting model the investor can play with, and a Make-an-Offer button. Dealrooms are private (link only) or published to a public marketplace. Investors browse free; a $39/mo membership unlocks the full comps pool, saving scenarios, and watchlist. Offers route to the wholesaler by email. Everything is instrumented. The MVP question: **will wholesalers supply deals and will investors use Dealrooms to evaluate them?**

Not in MVP: AI Investment Committee, automated intake (email/SMS/Slack/chat), title/escrow/anything transactional, mobile app, deal ratings.

---

## 1. Audit of the Signal codebase — keep / change / remove

### Keep as-is
| Thing | Why |
|---|---|
| `supabase/functions/underwrite/` steps 1–8, `lib/scoring.ts`, `lib/anthropic.ts`, `lib/rentcast.ts`, `lib/google.ts` | This is the property-intelligence engine. Address → geocode → property record → sale AVM + rent AVM (25 comps each) → deterministic similarity scoring → Claude trims to 5 → ARV/rent. Do not touch the math or the prompt. |
| Tables `jobs, subject_properties, avm_results, comp_scores, ai_comp_results, underwriting_results, debug_log, live_guard` | Engine storage. `comp_scores` already holds the **entire** comp pool with sub-scores and exclusion reasons — that is the Dealroom comps section for free. |
| `stripe-billing`, `stripe-webhook` functions; `plans, stripe_customers, subscriptions` tables | Checkout + portal + subscription sync. Reused with a new plan row. |
| `admin-stats`, `notify-owner`, migration 0008 | Owner notifications and stats. Extend, don't replace. |
| Google-only Supabase Auth | Investors and admins sign in with Google. |
| `.github/workflows/deploy-functions.yml`, `supabase/config.toml` | Deploy path. Add new functions to config.toml. |

### Change
| Thing | Change |
|---|---|
| `pipeline.ts` → `createUnderwriting` | Add an **admin-triggered** entry point: `POST /underwrite { address, dealroom_id }` callable only by admins (see §4 roles). Skips `checkRunAllowance`, skips the 7-day cache, does not write `underwritings`. On completion writes `dealrooms.intel_job_id` and sets `dealrooms.intel_status='ready'`. Keep the old user path compiling but it is unused. |
| `plans` table | Insert `dealroom_member` row: `name='The Comps Member', monthly_inquiries=null, price_cents=3900, overage_cents=null, mcp_access=false`. Signal's three rows stay. |
| `stripe-billing` | Accept `plan_key='dealroom_member'`. Checkout success URL → `${SITE_URL}/account?welcome=1`. |
| `check_run_allowance` | Not called on the Dealroom path. Leave the function in place. |
| `underwritings.verdict` column | Drop it (migration). `Buy/Pass/Review` violates the no-verdict rule. |
| `notify-owner` | Add events `deal_submitted`, `offer_submitted`, `member_subscribed`. |

### Remove / leave dormant
`keys` function, `signal-mcp/`, `user_credits`, `referrals`, `leads` — leave in place, do not wire into the Dealroom UI. The Bolt site is not in this repo and is untouched.

### Known data caveat (surface in the UI, don't hide it)
RentCast AVM comparables are a mix of **closed sales and listings**. Each comp carries `status` (`Active`/`Inactive`), `daysOld`, `price`, and where present `lastSaleDate`/`lastSalePrice`/`listedDate`/`removedDate`. The Dealroom must label each comp as **Sold** (has `lastSaleDate` within 12 months and `lastSalePrice`) or **Listed** (otherwise) and show the relevant date. Never present a listing as a sale.

---

## 2. Roles

| Role | How assigned | Can |
|---|---|---|
| `visitor` | not signed in | View public Dealrooms (limited comps), use the model in session, submit an offer (with contact info), sign up. |
| `investor` | signed in, no active subscription | Everything visitor can + watchlist (max 5), see offer history. |
| `member` | `subscriptions.status='active'` for `dealroom_member` | Full comps pool + selection, save scenarios, unlimited watchlist. |
| `admin` | `profiles.role='admin'` (set by SQL, OWNER) | Admin panel: wholesalers, deals, Dealrooms, generate intel, publish, view offers, analytics. |

`profiles` table: `user_id pk → auth.users, role text default 'investor', display_name, created_at`. Auto-created on first sign-in by trigger.

---

## 3. Data model (new migration `0009_dealroom.sql`)

All tables `public.*`, UUID PKs `gen_random_uuid()`, `created_at timestamptz default now()`. RLS on everything; policies in §3.9.

### 3.1 `wholesalers`
```
id, name text not null, company text, email text not null, phone text, market text,
notes text (admin-only), user_id uuid null → auth.users (if they ever sign in), created_at
```

### 3.2 `deals` — the wholesaler's claims. **Append-only. Never updated after creation.**
```
id, wholesaler_id → wholesalers, submitted_via text check in ('admin','email','sms','web','slack') default 'admin',
raw_submission text            -- verbatim text/email the wholesaler sent, if any
address_raw text not null,
asking_price int, assignment_fee int, arv_claimed int, rehab_claimed int,
description text, occupancy text, property_type text, beds int, baths numeric, sqft int,
lot_sqft int, year_built int, condition text, renovation_notes text,
closing_notes text, other_terms text, wholesaler_notes text,
created_by uuid → auth.users, created_at
```
Corrections are a **new** `deals` row + `dealrooms.deal_id` repointed; old row kept.

### 3.3 `dealrooms`
```
id, slug text unique not null (e.g. '123-main-st-phoenix-az-85020-x7k2'),
deal_id → deals, wholesaler_id → wholesalers,
visibility text check in ('draft','private','public') default 'draft',
status text check in ('active','under_contract','closed','withdrawn') default 'active',
intel_job_id uuid null → jobs, intel_status text check in ('none','running','ready','failed') default 'none',
address_formatted text, lat, lng, city, state, zip, market text,
headline_photo_path text,
published_at timestamptz, created_at, updated_at
```

### 3.4 `deal_media`
```
id, dealroom_id → dealrooms, kind text check in ('photo','document'), storage_path text not null,
caption text, sort_order int default 0, uploaded_by, created_at
```
Supabase Storage bucket `deal-media` (public-read for photos; documents signed URLs).

### 3.5 `comp_selections` — an investor's chosen comps for a Dealroom
```
id, dealroom_id, user_id, comp_score_id → comp_scores, selected bool default true, created_at
unique (dealroom_id, user_id, comp_score_id)
```

### 3.6 `model_scenarios` — saved model inputs (members only; session for others)
```
id, dealroom_id, user_id, name text default 'My scenario', inputs jsonb not null, outputs jsonb not null, created_at, updated_at
```
`inputs` shape defined in §6.

### 3.7 `offers`
```
id, dealroom_id, user_id null, offer_price int not null, terms text, contact_name text not null,
contact_email text not null, contact_phone text,
status text check in ('submitted','forwarded','accepted','declined','withdrawn') default 'submitted',
forwarded_at timestamptz, admin_notes text, created_at
```

### 3.8 `watchlist`
```
user_id, dealroom_id, created_at — pk (user_id, dealroom_id)
```

### 3.9 `events` — analytics, one row per event
```
id, event text not null, user_id null, anon_id text null (cookie uuid), dealroom_id null,
props jsonb, created_at
index (event, created_at), index (dealroom_id, created_at)
```
Event names (exact strings): `dealroom_view, dealroom_section_view (props.section), comp_expand, comp_toggle, model_change (props.field), model_reset, scenario_save, offer_open, offer_submit, signup, subscribe_click, subscribe_complete, watchlist_add, newsletter_signup, admin_deal_create, admin_intel_generate, admin_publish`. Client posts to `POST /track` (edge fn, anon allowed, rate-limited 60/min/ip).

### 3.10 RLS summary
- `wholesalers, deals, offers.admin_notes`: admin only. Investors never see wholesaler contact info.
- `dealrooms`: `visibility='public'` readable by anon; `private` readable by anyone **with the slug** (fetch via edge fn `GET /dealroom/:slug`, not direct table read); `draft` admin only.
- `deal_media`: readable if parent dealroom readable.
- `comp_scores` for a dealroom: exposed through `GET /dealroom/:slug/comps`, which trims to **5 comps** (the AI-final set) for non-members and returns the full pool for members/admins.
- `comp_selections, model_scenarios, watchlist`: own rows.
- `offers`: insert by anyone; select own rows; admin all.
- `events`: insert via edge fn only; select admin only.

---

## 4. Edge functions (new) — `supabase/functions/`

All return JSON, CORS `*`, errors `{error}`. Auth: Bearer session token; admin checks `profiles.role='admin'`.

| Function | Method / path | Auth | Does |
|---|---|---|---|
| `dealroom` | `GET ?slug=` | anon | Returns the public Dealroom payload (§5.2). Increments nothing (client tracks). |
| `dealroom` | `GET ?slug=&part=comps` | anon/member | Comp pool per §3.10 trimming. |
| `dealroom` | `GET ?list=1&market=&zip=&type=&min_price=&max_price=&sort=` | anon | Marketplace list, public only, paginated 24. |
| `admin-deals` | `POST {wholesaler, deal, media?}` | admin | Creates wholesaler (upsert by email), deal, dealroom (draft). Returns `dealroom_id, slug`. |
| `admin-deals` | `POST {action:'generate', dealroom_id}` | admin | Calls engine; sets `intel_status='running'`; engine callback sets `ready`. |
| `admin-deals` | `POST {action:'publish', dealroom_id, visibility}` | admin | Sets visibility + `published_at`; fires `notify_owner('admin_publish')`. |
| `admin-deals` | `POST {action:'status', dealroom_id, status}` | admin | under_contract/closed/withdrawn. |
| `offers` | `POST {dealroom_id, offer_price, terms, contact_*}` | anon | Inserts; emails wholesaler + owner (Resend, see §9); sets `forwarded_at`. |
| `scenarios` | `GET ?dealroom_id=` / `POST` / `DELETE` | member | CRUD on `model_scenarios`. Non-members get `402 {member_required:true}`. |
| `selections` | `POST {dealroom_id, comp_score_id, selected}` | member | Toggle. |
| `track` | `POST {event, dealroom_id?, props?, anon_id}` | anon | Insert into `events`. |
| `stripe-billing` (existing) | as today | investor | `plan_key:'dealroom_member'`. |

Config additions to `supabase/config.toml`: `dealroom, offers, track` → `verify_jwt=false`; `admin-deals, scenarios, selections` → `verify_jwt=true`.

---

## 5. Screens (`/web`, Lovable-generated, then refined in Claude Code)

### 5.0 Design language (give this verbatim to Lovable)
> Editorial financial research product. Think Bloomberg terminal meets a well-set magazine. White/near-white background, one ink color (#111), one accent (deep green #0F5C3E used only for actions and positive deltas), one warning (#B45309). Typography: serif display for headlines (e.g. "Newsreader" or "Source Serif"), a grotesk for UI and numbers (e.g. "Inter" with tabular numerals). Big numbers, generous whitespace, rules instead of cards, no gradients, no stock photos, no icons-as-decoration. Tables are real tables. Charts are minimal (one series, one color, labeled directly). Every number that isn't a fact has a small evidence-class tag next to it (§5.1). Mobile: single column, sticky "Make an offer" bar.

### 5.1 Evidence tags — used everywhere
Small uppercase label after any number:
- `WHOLESALER` — from `deals` (their claim)
- `FACT` — property record / public data
- `ESTIMATE` — engine output (ARV, rent, ranges)
- `YOUR ASSUMPTION` — investor-entered
Hover/tap shows "Source: …" one-liner. Never show vendor names (RentCast/Google/Claude) — say "property records," "comparable data," "The Comps analysis."

### 5.2 Public Dealroom — `/d/:slug`
Sections in order; each is a section-view analytics event.

1. **Header** — address (display), city/state/zip, market, status pill (Active / Under contract / Closed). Photo strip (headline + thumbnails, lightbox). Wholesaler company name only (no contact).
2. **The Deal** (all `WHOLESALER`) — big numbers: Asking price · Assignment fee · Claimed ARV · Claimed rehab. Then description, occupancy, condition, renovation notes, closing notes, other terms, wholesaler notes. Documents list. Text rendered verbatim, no editing.
3. **Property Facts** (`FACT`) — beds/baths/sqft/lot/year/type; where the wholesaler's numbers differ from the record, show both side-by-side with a discreet "differs from record" flag. Do not pick a winner.
4. **Valuation Evidence** (`ESTIMATE`) — "Comparable-supported value: $X (range $L–$H)" and "Comparable-supported rent: $R/mo (range)". Beneath: Claimed ARV vs. comparable-supported value as a two-bar comparison. Text: "Here are the properties that support this." → jumps to Comps.
5. **Comps** — table: Address · Sold/Listed + date · Price · $/sqft · Sqft · Bd/Ba · Year · Distance · Similarity (0–100) · Selected (checkbox, members). Default rows = the 5 AI-final comps, marked "Analysis set." Members see "Show full pool (N)" which expands to every `comp_scores` row incl. excluded ones (greyed, with exclusion reasons in plain English: "over 1 mi away", "500+ sqft difference", "20+ yrs age difference", "lot size tier differs"). Row expand shows sub-scores and the AI note (`ai_notes`) for final comps. A small map with subject pin + comp pins (Mapbox GL or Leaflet + OSM tiles; no Google branding). **Selected comps drive "Your ARV" in the model:** `your_arv = mean(selected $/sqft) × subject sqft`, shown with tag `YOUR ASSUMPTION`. Non-members see the checkbox disabled with a "Members select their own comps" tooltip → subscribe.
6. **Market context** — from the engine's pool stats only (MVP has no ZIP dataset): median $/sqft of sale pool, median DOM proxy (`daysOld`) of listed comps, count active vs sold within 1 mi. Label the section "From the comparable pool." Nothing else; no invented ZIP stats.
7. **Model** — see §6. Sticky summary bar on scroll: Purchase · All-in basis · Exit · Spread · Margin.
8. **Make an Offer** — button opens sheet: offer price (prefilled = model purchase price), terms (textarea), name, email, phone (prefill if signed in). Submit → "Sent to the wholesaler. They'll reply to your email." → `offer_submit` event.
9. **Footer** — "The Comps provides evidence, not advice. Nothing here is a recommendation to buy." + newsletter signup field (`newsletter_signup` event; store in `leads` table with `address=null`).

Non-member gating (one pattern, used 3 places): a slim inline panel, not a modal — "Members see all N comps, select their own, and save scenarios. $39/month. [Join] [Sign in]".

### 5.3 Marketplace — `/deals`
Filters (query-string backed): market, ZIP, property type, price range, beds min, sort (newest / price asc / price desc / spread desc where spread = claimed ARV − asking − claimed rehab). List rows (not cards): photo thumb · address · asking · claimed ARV · comparable-supported value · sqft · bd/ba · days listed here. Click → Dealroom. Empty state copy: "No public deals match. Wholesalers: send us yours." → `/wholesalers`.

### 5.4 Wholesaler landing — `/wholesalers`
Copy: "Send us the deal. We turn it into a Dealroom your buyers can actually evaluate. Free." Form: name, company, email, phone, market, paste-your-deal textarea, photo upload (optional). Submit → inserts `wholesalers` (upsert by email) + `deals` with `submitted_via='web'` + draft dealroom → `notify_owner('deal_submitted')`. Thank-you: "We'll have your Dealroom link to you within one business day." (Staff generate + publish in admin.)

### 5.5 Account — `/account`
Plan status (from `stripe-billing` GET), Join/Manage buttons, watchlist, saved scenarios (link to Dealroom + scenario), my offers with status.

### 5.6 Admin — `/admin/*` (role=admin only; plain, dense, functional)
- `/admin/deals` — table of dealrooms: address · wholesaler · visibility · intel_status · offers count · views (from events) · actions.
- `/admin/deals/new` — pick/create wholesaler; paste raw submission; structured deal fields (all optional except address); photo/doc upload. Save → draft.
- `/admin/deals/:id` — deal fields read-only (with "Correct" = creates new deal row); **Generate intel** button (shows engine steps 1–8 progress via job polling); intel summary; **Preview** link; visibility toggle Draft/Private/Public; status; offers list with forward status and admin notes.
- `/admin/wholesalers` — list + edit.
- `/admin/analytics` — the MVP metrics in §7 as a simple table, last 7/30 days.

---

## 6. Underwriting model — exact math

Runs entirely client-side (pure TS module `web/src/lib/model.ts`, unit-tested). Same module used server-side when saving scenarios to compute `outputs` (copy the file into the edge function; keep them identical).

### Inputs (`inputs` jsonb)
```ts
type Inputs = {
  purchase_price: number;        // default: deals.asking_price (WHOLESALER)
  assignment_fee: number;        // default: deals.assignment_fee ?? 0; included in purchase basis
  rehab: number;                 // default: deals.rehab_claimed ?? 0
  arv: number;                   // default: engine ARV (ESTIMATE); overridden by selected comps or manual entry
  closing_buy_pct: number;       // default 0.02  (of purchase_price)
  closing_sell_pct: number;      // default 0.06  (of arv; agent + seller closing)
  financing_ltc: number;         // default 0.0   (0 = cash). Loan = ltc × (purchase + rehab)
  interest_rate_annual: number;  // default 0.12
  points_pct: number;            // default 0.02 of loan
  hold_months: number;           // default 6
  monthly_holding_other: number; // default 0 (taxes, insurance, utilities — investor enters)
  strategy: 'flip' | 'rental';   // default 'flip'
  monthly_rent: number;          // default: engine rent (ESTIMATE); rental only
  vacancy_pct: number;           // default 0.05
  opex_pct: number;              // default 0.35 of gross rent (taxes, ins, mgmt, maintenance)
}
```

### Outputs
```
purchase_basis     = purchase_price + assignment_fee
closing_buy        = purchase_price × closing_buy_pct
loan               = financing_ltc × (purchase_basis + rehab)
cash_in            = purchase_basis + rehab + closing_buy − loan + points
points             = loan × points_pct
interest           = loan × interest_rate_annual / 12 × hold_months
holding_other      = monthly_holding_other × hold_months
total_basis        = purchase_basis + rehab + closing_buy + points + interest + holding_other
closing_sell       = arv × closing_sell_pct
net_proceeds       = arv − closing_sell − loan          (loan repaid at sale)
spread             = arv − closing_sell − total_basis   (= profit before tax)
margin_on_arv      = spread / arv
roi_on_cash        = spread / cash_in                    (cash_in>0 else null)
annualized_roi     = roi_on_cash × 12 / hold_months
break_even_arv     = total_basis / (1 − closing_sell_pct)    (arv at which spread = 0)
arv_cushion_pct    = (arv − break_even_arv) / arv            ("how wrong can ARV be before you lose money")
-- rental strategy adds:
gross_rent_annual  = monthly_rent × 12
noi                = gross_rent_annual × (1 − vacancy_pct) × (1 − opex_pct)
all_in_rental      = purchase_basis + rehab + closing_buy
cap_rate_on_cost   = noi / all_in_rental
```

### Sensitivity table (always shown, this is the "what if I'm wrong" section)
Rows: ARV −10%, −5%, 0, +5%; Columns: Rehab +0%, +25%, +50%. Cell = spread. Color: negative cells warning color; nothing green.
Second strip: hold months 3 / 6 / 9 / 12 → spread.

### Display rules
- Every input has its evidence tag and a "reset to default" affordance.
- ARV input shows a source switch: `Wholesaler ($X)` / `Comparable-supported ($Y)` / `My comps ($Z, n selected)` / `Manual`.
- Session persistence: `sessionStorage` per slug (this is a hosted site, so it's fine). Members: "Save scenario" → `scenarios` POST.
- Never label any output "profit you will make." Label: "Spread at these assumptions."

---

## 7. Analytics — MVP metrics (from `events` + tables), `/admin/analytics`
Deals submitted (`deals` count by `submitted_via`) · Deals published · Unique Dealroom viewers (distinct `coalesce(user_id, anon_id)`) · Views per Dealroom · Median time on Dealroom (first→last event per session) · % viewers who expanded a comp · % who changed the model · Signups · Member conversions · Offers · Offers per published deal · Newsletter signups. Wholesalers with ≥1 deal · Returning viewers (seen on ≥2 distinct days).

---

## 8. Build sequence — tickets for the builder (do in order; each is one PR)

Each ticket: acceptance criteria are the definition of done. Write the test named. Don't start the next ticket until the current one's checks pass.

**T0 — Fork + housekeeping.**
Copy repo to `dealroom` (GitHub, Mac creates). Add `CLAUDE.md` (provided). Add `/web` placeholder. CI still deploys functions.
✓ `supabase functions deploy` dry-run lists all existing functions.

**T1 — Migration 0009 (schema in §3) + `profiles` trigger + drop `underwritings.verdict` + `plans` seed.**
✓ Migration applies clean on a fresh shadow DB; `select * from plans where plan_key='dealroom_member'` returns 1 row; RLS: anon `select` on `deals` returns 0 rows; anon `select` on public `dealrooms` returns rows.

**T2 — Engine admin path.**
In `pipeline.ts` add `createAdminUnderwriting(body, bearer)`: require admin; require `dealroom_id`; no allowance/cache/history; on success/fail update `dealrooms.intel_job_id/intel_status`. Route in `index.ts` on `body.dealroom_id` presence.
✓ With `MOCK_EXTERNAL=true`, POST as admin returns 202; polling reaches `complete`; `dealrooms.intel_status='ready'`; `comp_scores` has rows for the job; POST as non-admin → 403.

**T3 — `admin-deals` function** (create / generate / publish / status) + Storage bucket `deal-media`.
✓ Create returns slug; duplicate wholesaler email upserts; publish sets `published_at`; non-admin 403.

**T4 — `dealroom` function** (public payload, comps trimming, marketplace list).
Payload assembles: dealroom + deal (minus admin notes) + wholesaler company name only + subject_properties + underwriting_results.report_json + media URLs. Comps part: for members, all `comp_scores` rows for `intel_job_id` with `comp_json` normalized to `{address, kind:'sold'|'listed', date, price, price_per_sqft, sqft, beds, baths, year_built, distance_miles, similarity_0_100, excluded, exclusion_reasons_plain[], in_analysis_set, ai_note, lat, lng}`; for others only rows whose address is in `ai_comp_results.final_comps_json`.
✓ Private slug fetch works without auth; draft slug 404s for anon; member vs anon comps count differs; exclusion reasons map to the four plain-English strings.

**T5 — `offers`, `track`, `scenarios`, `selections` functions.** Resend email on offer (to wholesaler email + owner; template: address, offer, terms, contact, link). Rate limit `track`.
✓ Offer insert + `forwarded_at` set + notify fired; scenarios 402 for non-member; track rejects unknown event names.

**T6 — Web scaffold (Lovable).** Prompt Lovable with §5.0 + routes list (`/`, `/deals`, `/d/:slug`, `/wholesalers`, `/account`, `/admin/*`) + Supabase connection (publishable key only). Export to `/web` in the repo. Then everything below is done in Claude Code, not Lovable.
✓ `npm run build` passes; routes render placeholder content; Google sign-in works.

**T7 — `web/src/lib/model.ts` + tests.** Implement §6 exactly. Vitest with the worked example in §10.
✓ All §10 assertions pass.

**T8 — Dealroom page** (§5.2 sections 1–4, 8, 9).
✓ Renders a seeded dealroom; evidence tags present on every number; wholesaler contact never appears in the DOM or network payload.

**T9 — Comps section + map + selection** (§5.2 §5).
✓ Anon sees exactly 5; member sees full pool; toggling selection updates "My comps" ARV live; excluded rows greyed with reasons.

**T10 — Model UI + sensitivity + session persistence + save scenario.**
✓ Changing any input updates outputs within one frame; reload restores session; member save round-trips.

**T11 — Marketplace + filters + wholesaler landing + account page.**
✓ Filters reflected in URL; wholesaler form creates draft + notifies owner.

**T12 — Admin pages** (§5.6).
✓ Full flow: new deal → generate (progress) → preview → publish → visible on `/deals` → offer received shows in admin.

**T13 — Stripe.** OWNER creates product "The Comps Member" $39/mo in Stripe (live), pastes price id into `plans.stripe_price_id`. Wire Join buttons → `stripe-billing` checkout; gating reads subscription status.
✓ Test-mode checkout → webhook → `subscriptions` row → comps pool unlocks without reload.

**T14 — Analytics page + event wiring audit.** Every event in §3.9 fires from the right place.
✓ Manual walkthrough produces one row per event name.

**T15 — Seed + launch checklist.** Seed script: 3 wholesalers, 6 deals (2 private, 4 public) using `MOCK_EXTERNAL=true`. Checklist: secrets set (RESEND_API_KEY, SITE_URL, STRIPE_*), `live_guard` cap raised to 2000, custom domain `deals.thecomps.co`, footer disclaimer present, Privacy/Terms pages linked.

Estimated: T1–T5 ≈ 2 builder-days, T6–T12 ≈ 4, T13–T15 ≈ 1.

---

## 9. Secrets / services (OWNER)
Existing: `SUPABASE_*`, `GOOGLE_MAPS_API_KEY`, `RENTCAST_API_KEY`, `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
New: `RESEND_API_KEY` (transactional email; free tier fine), `SITE_URL=https://deals.thecomps.co`, `NOTIFY_OWNER_EMAIL`. Map tiles: none needed with Leaflet + OSM; if Mapbox, `VITE_MAPBOX_TOKEN` (public token, browser-safe).

---

## 10. Worked example for model tests
Inputs: purchase 125,000 · assignment 5,000 · rehab 25,000 · arv 175,000 · closing_buy 2% · closing_sell 6% · ltc 0.8 · rate 12% · points 2% · hold 6 · other holding 300/mo · flip.
```
purchase_basis = 130,000
closing_buy    = 2,500
loan           = 0.8 × 155,000 = 124,000
points         = 2,480
interest       = 124,000 × 0.01 × 6 = 7,440
holding_other  = 1,800
total_basis    = 130,000 + 25,000 + 2,500 + 2,480 + 7,440 + 1,800 = 169,220
cash_in        = 130,000 + 25,000 + 2,500 − 124,000 + 2,480 = 35,980
closing_sell   = 10,500
spread         = 175,000 − 10,500 − 169,220 = −4,720
margin_on_arv  = −0.0270
roi_on_cash    = −0.1312
break_even_arv = 169,220 / 0.94 = 180,021.28
arv_cushion    = (175,000 − 180,021.28)/175,000 = −0.0287
```
(Yes, the example loses money at 80% LTC — that's the point of the tool. Cash case: loan 0, points 0, interest 0 → total_basis 159,300, spread 5,200, break-even 169,468.)
Sensitivity cell ARV −5% / rehab +25% (financed case): arv 166,250, rehab 31,250 → loan 129,000, points 2,580, interest 7,740, total_basis 175,870, closing_sell 9,975, spread −19,595.

---

## 11. Out of scope — do not build even if it seems easy
AI Investment Committee · email/SMS/Slack/chat intake · ZIP/market datasets · deal ratings or scores of any kind · investor-to-wholesaler chat · document e-sign · multiple markets logic (market is just a text field) · admin roles beyond one `admin` · i18n · dark mode.
