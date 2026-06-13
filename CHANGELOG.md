# Changelog

## 2026-06-12

Stripe billing wired up (LIVE mode) and engine metering shipped.

- **Stripe products + prices created (live):** Signal Casual $49/mo, Signal Investor $99/mo, Signal Institution $249/mo. Old/legacy products archived.
- **Price IDs wired into `plans`:** `casual`, `investor`, `institution` now carry their live `stripe_price_id`.
- **Stripe webhook endpoint** created (events: checkout.session.completed, customer.subscription.created/updated/deleted, invoice.created).
- **`stripe-webhook` edge function hardened + redeployed (v3):** re-fetches the subscription via the SDK and accepts billing-period dates on either the subscription or its items (resilient to newer Stripe API versions).
- **`underwrite` edge function redeployed (v19) with metering:** now calls `check_run_allowance` / `record_overage`; paid subscribers are no longer capped at the 2-report trial. All 17 files verified byte-identical to source.
- **Repo + Supabase GitHub integration:** initialized the repo at the project root, recovered migration `0007` (billing/metering) from the live database, added `supabase/config.toml` and `.gitignore`, and reconciled migration history so deploys from `main` apply only future changes.

### Owner-managed (outside the repo)

- Supabase Edge Function secrets: `STRIPE_SECRET_KEY` (live), `STRIPE_WEBHOOK_SECRET`, `SITE_URL`.
- Google OAuth client + enabling the Google provider in Supabase Auth.
