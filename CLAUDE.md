# CLAUDE.md — Dealroom (The Comps)

You are building the Dealroom MVP from `docs/dealroom/DEALROOM-SPEC.md`. Read it fully before any change. Work one ticket (§8) per PR, in order. Do not skip ahead, do not add features the spec doesn't name.

## Non-negotiable product rules
1. **Never write a verdict.** No "approved," "good deal," "buy," "pass," scores, grades, stars, or "this deal will make $X." Outputs are "spread at these assumptions." If you find yourself writing recommendation copy, stop.
2. **Never alter wholesaler-supplied data.** `deals` rows are append-only. Corrections are new rows. Display their text verbatim.
3. **Every number carries an evidence tag** (`WHOLESALER` / `FACT` / `ESTIMATE` / `YOUR ASSUMPTION`). A number without a tag is a bug.
4. **Never name data vendors** in anything user-visible (RentCast, Google, Claude, Anthropic, MLS). Say "property records," "comparable data," "The Comps analysis."
5. **Never present a listing as a sale.** Comps are labeled Sold or Listed with the relevant date.
6. **Wholesaler contact info never reaches an investor** — not in payloads, DOM, or emails to investors.
7. **Engine math and prompt are frozen.** Do not edit `lib/scoring.ts`, `lib/anthropic.ts`, or steps 4–8 except where a ticket explicitly says so.

## Engineering rules
- Secrets: only the Supabase publishable key ever reaches the browser. Everything else is an Edge Function secret.
- Every table has RLS enabled. Add the policy in the same migration as the table.
- Public reads go through edge functions, not direct table queries, except `dealrooms` (public rows) and `deal_media`.
- Model math lives in one pure module (`web/src/lib/model.ts`), unit-tested against §10 of the spec; the edge-function copy must be byte-identical.
- Analytics event names are the exact strings in spec §3.9. No new event names without adding them there.
- Real engine runs cost ~$0.35 and count against `live_guard`. Develop with `MOCK_EXTERNAL=true`. Never loop the engine.
- Frontend: React + Vite + Tailwind in `/web`. No component libraries beyond what Lovable scaffolded. No dark mode, no i18n.
- Commit messages: `T<ticket>: <what>`. One PR per ticket. Include the ticket's ✓ checks as a checklist in the PR body with evidence (test output or screenshot).

## When unsure
Stop and write the question into `docs/dealroom/QUESTIONS.md` with your proposed default, then proceed with the default. Do not silently guess on anything touching rules 1–7.
