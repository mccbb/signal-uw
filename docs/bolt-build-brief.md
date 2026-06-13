# Signal UW — Website Build Brief (for Bolt)

Build the **signaluw.com** website. The backend "engine" is **already built and
deployed** — your job is only the website that talks to it. Do NOT build any
property data, comps, valuation, or AI logic; that all lives behind one API.

## Stack

- React + Tailwind (Bolt default is fine).
- **Supabase** for auth (Google only) and for reading the logged-in user's
  data. Connect this Supabase project:
  - Project URL: `https://nmguadctlkhunkfhfimb.supabase.co`
  - Publishable (anon) key: `sb_publishable_s2huboLvjn2np4XfzP6RVA_2B57s9BI`
  - Use the `@supabase/supabase-js` client with these. **Never** put any other
    key in the browser.
- **Auth is Google-only.** In Supabase → Authentication → Providers, enable
  **Google** and **disable Email**. Sign-in button calls
  `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: <site url> } })`.
- **Users must be signed in to run anything** — there is no anonymous flow.

## The one API the site calls

Everything goes through one endpoint base:
`https://nmguadctlkhunkfhfimb.supabase.co/functions/v1`

Always send the publishable key as the `apikey` header, AND the signed-in user's
session token as `Authorization: Bearer <access_token>` (from
`supabase.auth.getSession()`). Every request must be authenticated.

### Run an underwrite
`POST /underwrite`  body `{ "address": "..." }`

Responses:
- `202 { job_id, status:"queued" }` → then poll (below).
- `200 { ...report, cached:true }` → instant cache hit, render immediately.
- `401 { need_signin:true }` → user isn't signed in → show the Google sign-in button.
- `402 { trial_exhausted:true }` → their 2 free reports are used → show the upgrade paywall.

### Poll a job
`GET /underwrite?job_id=<id>` every 2s until `status` is `complete` or `failed`.
- While running it returns `{ status:"running", current_step: 1..8 }` → drive a progress bar.
- On done: the full report (shape below).
- On failure: `{ status:"failed", error_message }` → show that message.

### Report shape (what you render)
```jsonc
{
  "status": "complete",
  "address": "1112 E Malibu Dr, Tempe, AZ 85282, USA",
  "arv": 561200, "arv_range_low": 493700, "arv_range_high": 629800,
  "estimated_rent": 2270, "rent_range_low": 1815, "rent_range_high": 2730,
  "comps_analyzed": 50,
  "sale_comps": [ { "address": "...", "price_per_sqft": 372.4, "ai_notes": "..." } ],
  "rent_comps": [ /* same shape */ ],
  "notes": [ "ARV and rent are derived from the final comparable sets." ]
}
```

### History (logged-in)
`GET /underwrite?history=1` with the Bearer token →
`{ underwritings: [ { id, address, created_at, arv, estimated_rent } ] }`.

### API keys for the MCP (logged-in, account page)
- `POST /keys` `{ label }` → `{ api_key, key_prefix }` — show `api_key` ONCE, never again.
- `GET /keys` → `{ keys: [ { id, key_prefix, label, created_at, last_used_at, revoked } ] }`.
- `POST /keys` `{ action:"revoke", id }` → revoke.
All with the Bearer token.

## Homepage chat flow (the core experience)

1. A chat-style box: "Drop any US address — your first 2 reports are free."
2. **Require Google sign-in to run.** If the visitor isn't signed in (or the API
   returns `401 need_signin`), show a "Continue with Google" button. After they
   sign in, run the address they entered.
3. Show "Running analysis on {address}…" and a progress indicator (steps 1–8).
4. On complete, render a **report card**: ARV (with range), estimated rent (with
   range), and the comps list with their notes.
5. Download buttons on the card: **PDF Report, CSV, Flip Model, Rental Model** —
   wire as placeholder toasts ("Coming soon") for now.
6. Each signed-in account gets **2 free reports**. The 3rd returns
   `402 trial_exhausted` → show the paywall: "You've used your free reports. Start for $49/month."
7. Repeats of the same address within 7 days come back instantly (`cached:true`)
   and don't count against the free 2. All runs are saved to the user's History.

## Pages — keep it to THREE

Only three pages for now. Pricing / How-it-works / the chat all live as **sections
on the landing page**, not separate routes.

- **Landing** — hero + the chat (core experience) + "How it works" + capabilities
  (ARV, estimated rent, comps) + pricing section + footer.
  - Pricing section — three cards + enterprise:
    - Casual $49/mo · 30 inquiries · Browser
    - Investor $99/mo · 75 inquiries · Browser + MCP access
    - Institution $249/mo · 249 inquiries · $1.00/additional · Browser + MCP access
    - Enterprise "Custom Underwriting Agents" — Schedule a Call CTA.
- **Privacy** — real privacy policy content.
- **Terms** — real terms of service content.

Logged-in app pages (Dashboard, History, Billing, Downloads, Referral) are **out
of scope for now** — we'll plan and build those in a later phase.

## Hard rules (important)

- **Never reveal data sources.** Do not show or mention RentCast, Google, Zillow,
  Claude, MLS, or any provider anywhere in the UI. The report is "Signal's analysis."
- Lead with **ARV** and **estimated rent**; comps are supporting detail.
- Do **not** compute or display cap rate, DSCR, cash flow, or buy/pass verdicts —
  not in this version.
- Treat the report's `notes` as the explanation to show users.

## Out of scope (don't build)

- The underwriting engine, comps, scoring, AI — already built behind the API.
- Stripe billing logic — buttons stub for now (we wire it next).
- Any server-side secrets — the site only ever uses the publishable key + the
  user's own session token.
