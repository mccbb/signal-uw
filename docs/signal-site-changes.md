# Signal site — changes to make (paste this into Bolt)

The site looks great. These are content/wiring changes so it matches what the
engine actually does. **This is the only doc you need to give Bolt now** — it
supersedes the earlier build brief and chat-wiring docs (those were for building
from scratch; the site now exists).

## The big one: this is INVESTOR underwriting, not insurance

Signal returns, for any US home: **ARV (after-repair value), estimated monthly
rent, value ranges, and the comparable properties used** — for real-estate
investors (flips & rentals). The current copy reads like *insurance* underwriting
(flood zones, crime, "coverage," "Approved"). Remove all of that.

Rules to apply everywhere:
- Outputs are **ARV + estimated rent + comps**. No flood/fire/crime/insurance/coverage.
- **No buy/pass/approve verdict.** (The engine doesn't produce one.)
- **Never name data sources** (no Zillow/MLS/RentCast/Google, etc.). It's "Signal's analysis."
- "Claude / your AI assistant" is fine to name (that's the user's MCP client, not a data source).

## Section-by-section edits

**1. Hero.** Current sub-headline says insights go "directly to your Claude
assistant," which makes it sound MCP-only. It works on the website too.
- Suggested sub-headline: *"Enter any US address and get an investor-grade ARV, rent estimate, and the comps behind them — in seconds. Use it right here, or inside Claude/ChatGPT."*

**2. Demo card (under the hero).** Replace the insurance sample with a real one:
- Current: "Property value $485,000, Flood Zone X (minimal risk), Crime index below average. Recommendation: Approved with standard coverage."
- New: *"Analysis for 1112 E Malibu Dr, Tempe, AZ — ARV $561,200 (range $493,700–$629,800), estimated rent $2,270/mo, based on 5 sale comps and 5 rent comps."*

**3. "How Signal works" → step 2 ("Data Retrieval").**
- Current: "We pull property records, tax data, flood zones, crime stats, and more."
- New: *"We pull the property's details and recent comparable sales and rentals nearby."* (No flood/crime/tax; no source names.)
- Step 3 ("AI Analysis"): *"Our model scores and refines the comps, then derives ARV and estimated rent from the best matches."*

**4. Capabilities section.** Replace the four cards with what we actually return:
- **ARV** — after-repair value from the final comparable sales.
- **Estimated Rent** — monthly rent from the final comparable rentals.
- **Comp Analysis** — the exact comps used, each with notes on why it fits.
- **Instant Results** — full report in under a minute (repeats are instant).
- Delete "Risk Analysis (flood zones, fire risk, crime data, environmental factors)" entirely.

**5. The "Try it right now" chat — wire it to the live engine.** It must call the
real API and be **gated behind Google sign-in** (see auth below). Flow:
- User enters an address → if not signed in, show **Continue with Google**.
- POST to the engine, poll the job, render a report card (ARV + range, rent +
  range, the comps). Each account gets **2 free reports**, then a paywall.
- Wiring:
```js
const SIGNAL_URL = "https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/underwrite";
const ANON = "sb_publishable_s2huboLvjn2np4XfzP6RVA_2B57s9BI";

async function runUnderwrite(address) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return supabase.auth.signInWithOAuth({ provider: "google",
    options: { redirectTo: window.location.origin } });

  const headers = { "Content-Type": "application/json", apikey: ANON,
    Authorization: `Bearer ${token}` };
  const start = await fetch(SIGNAL_URL, { method: "POST", headers,
    body: JSON.stringify({ address }) }).then(r => r.json().then(j => ({ s: r.status, j })));
  if (start.s === 401 && start.j.need_signin) return signInWithGoogle();
  if (start.s === 402 && start.j.trial_exhausted) return showPaywall(); // "2 free used"
  if (start.j.status === "complete" || start.j.cached) return renderReport(start.j);

  const jobId = start.j.job_id;
  for (let i = 0; i < 45; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const v = await fetch(`${SIGNAL_URL}?job_id=${jobId}`, { headers }).then(r => r.json());
    updateProgress(v.current_step);            // 1..8 progress bar
    if (v.status === "complete") return renderReport(v);
    if (v.status === "failed") throw new Error(v.error_message);
  }
}
```
- Report fields to render: `arv`, `arv_range_low/high`, `estimated_rent`,
  `rent_range_low/high`, `comps_analyzed`, `sale_comps[]`, `rent_comps[]` (each comp
  has `address`, `price_per_sqft`, `ai_notes`), and `notes[]`.

**6. Auth — Google only.** In Supabase → Authentication → Providers, enable
**Google**, disable **Email**. Every "Try Free" / chat run requires sign-in; the
button uses `supabase.auth.signInWithOAuth({ provider: 'google' })`.
(You still need to create the Google OAuth client in Google Cloud with redirect
URI `https://nmguadctlkhunkfhfimb.supabase.co/auth/v1/callback`.)

**7. MCP config block.** The shown config (`@signaluw/mcp-server`) isn't real yet.
Use the actual server: command `node`, args `[".../signal-mcp/index.mjs"]`, env
`SIGNAL_API_KEY`. (Once it's published to npm it can become `npx -y signal-mcp`.)
Keep this section lower-key — MCP is the Pro add-on, not the main path.

**8. Pricing — keep the site's pricing as-is.** Casual $49 / 30 inquiries,
Investor $99 / 75 (MCP access), Institution $249 / 249 ($1.00 per additional
inquiry, MCP access), plus the Enterprise "Custom Underwriting Agents" tier.
No change needed here — these are the final numbers. (Lower tiers are hard-capped
with no overage; only Institution has the $1.00 overage. Billing is now live —
Stripe products/prices exist and the engine meters against these limits.)

**9. Pages — keep it to three.** Landing (with these sections), **Privacy**, and
**Terms**. No dashboard/history/billing/downloads pages yet — those come later.
Make sure Privacy and Terms have real content (not placeholders).

**10. Remove the old free-query gating (IMPORTANT).** The site currently calls two
Supabase functions — `check-user` and `increment-query` — to count "free queries"
by email. **Delete all client code that calls them.** They are non-functional
(they target a table that doesn't exist) and they bypass the real metering. All
gating now lives in the engine: a signed-in account gets 2 free reports, then the
engine returns `402 trial_exhausted`; subscribers are metered against their plan
and get `402 limit_reached` (with `plan_key`, `inquiry_limit`, `period_end`) when
capped. The chat should rely **only** on the `/underwrite` responses (handle both
`trial_exhausted` and `limit_reached` → show the paywall). Once the new site is
live and no longer references these endpoints, the `check-user` / `increment-query`
functions and the empty `user_credits` / `user_trials` tables will be deleted
server-side.

**11. Wire the pricing buttons to Stripe Checkout.** Right now the plan buttons do
nothing. Each paid plan's button (and the paywall's upgrade buttons) should call
the `stripe-billing` function, which returns a Stripe Checkout URL to redirect to.
Plan keys: **`casual`, `investor`, `institution`**. Enterprise stays a
"Schedule a Call" link (no checkout). Requires the user to be signed in (same
Google session as the chat).

```js
const BILLING_URL = "https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/stripe-billing";
const ANON = "sb_publishable_s2huboLvjn2np4XfzP6RVA_2B57s9BI";

// planKey: "casual" | "investor" | "institution"
async function subscribe(planKey) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    return supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
  }
  const res = await fetch(BILLING_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON,
      Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "checkout", plan_key: planKey }),
  });
  const out = await res.json();
  if (out.url) window.location.href = out.url;        // → Stripe Checkout
  else alert(out.error || "Could not start checkout. Please try again.");
}
```

- Wire: Casual button → `subscribe("casual")`, Investor → `subscribe("investor")`,
  Institution → `subscribe("institution")`. The paywall's upgrade buttons call the
  same function.
- After payment, Stripe returns the user to `/?checkout=success` (or
  `/?checkout=cancel`). On `?checkout=success`, show a brief "You're subscribed"
  confirmation and re-fetch billing status (GET `stripe-billing`) so the UI
  reflects the new plan.
- **Manage/cancel subscription:** for signed-in subscribers, a "Manage billing"
  link can POST `{action:"portal"}` to the same function and redirect to the
  returned `url` (Stripe Billing Portal).

**12. Add an "API Keys" section to the logged-in account area (for MCP).** Users
need a Signal API key to use the Claude/MCP extension. The backend `keys` function
already does everything — this is UI only. Put it on an account page/section that's
only visible when signed in (e.g., `/account`, or an "API Keys" tab). MCP access is
an Investor+ perk, so optionally only show this to plans with `mcp_access` (from
GET `stripe-billing`), but minting itself works for any signed-in user.

Endpoint: `https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/keys`
- `GET` → `{ keys: [{ id, key_prefix, label, created_at, last_used_at, revoked }] }`
- `POST { label? }` → mints a key, returns `{ api_key, key_prefix, label }` — **the
  full `api_key` is returned ONCE and never again.**
- `POST { action:"revoke", id }` → revokes a key.

```js
const KEYS_URL = "https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/keys";
const ANON = "sb_publishable_s2huboLvjn2np4XfzP6RVA_2B57s9BI";

async function authHeaders() {
  const { data } = await supabase.auth.getSession();
  return { "Content-Type": "application/json", apikey: ANON,
    Authorization: `Bearer ${data.session?.access_token}` };
}
async function listKeys() {
  const r = await fetch(KEYS_URL, { headers: await authHeaders() });
  return (await r.json()).keys || [];
}
async function createKey(label) {                 // returns { api_key, ... } ONCE
  const r = await fetch(KEYS_URL, { method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ label: label || null }) });
  return r.json();
}
async function revokeKey(id) {
  await fetch(KEYS_URL, { method: "POST", headers: await authHeaders(),
    body: JSON.stringify({ action: "revoke", id }) });
}
```

UX requirements:
- Show the user's existing keys as a list: the `key_prefix` (e.g. `sgl_xxxx…`), `label`,
  created date, last-used date, and a **Revoke** button per row. (You only ever get
  the prefix back, never the full key — that's expected.)
- A **"Generate new key"** button → optional label input → call `createKey()` →
  display the returned `api_key` **once** in a copyable box with a **Copy** button and
  a clear warning: *"Copy this now — for your security it won't be shown again."*
  After they copy/dismiss, refresh the list.
- Never store the raw key in app state longer than needed to display it; never log it.
- Link to this page from the nav account menu and from the MCP setup page's "Get your
  API key" step.

## Engine facts (reference)
- Base: `https://nmguadctlkhunkfhfimb.supabase.co/functions/v1`
- `POST /underwrite { address }` (Bearer = Google session) → 202 job / 200 cached / 401 need_signin / 402 trial_exhausted
- `GET /underwrite?job_id=…` → poll; `GET /underwrite?history=1` → saved history
- `POST /keys { label }` / `GET /keys` / `POST /keys {action:"revoke",id}` → MCP key management
- Never expose the service-role key or any provider key in the browser — only the publishable key + the user's session token.
