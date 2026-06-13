// Signal UW — billing surface for the website (logged-in users only).
//   GET  /stripe-billing                         → current plan + usage (paywall/account)
//   POST /stripe-billing { action:"checkout", plan_key }  → Stripe Checkout URL
//   POST /stripe-billing { action:"portal" }              → Stripe Billing Portal URL
// Auth: the signed-in user's Supabase session token (Bearer). Never anonymous.
// Stripe secret + price IDs live in env / the plans table — never in the browser.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@16";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};
function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
function stripe(): Stripe {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured yet.");
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

async function userFromBearer(db: SupabaseClient, bearer: string | null): Promise<User | null> {
  if (!bearer) return null;
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (bearer === anon) return null;
  const { data, error } = await db.auth.getUser(bearer);
  if (error || !data?.user) return null;
  return data.user;
}

// Reuse one Stripe customer per user across subscription changes.
async function getOrCreateCustomer(db: SupabaseClient, st: Stripe, user: User): Promise<string> {
  const { data: existing } = await db
    .from("stripe_customers")
    .select("stripe_customer_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing?.stripe_customer_id) return existing.stripe_customer_id as string;

  const cust = await st.customers.create({
    email: user.email ?? undefined,
    metadata: { user_id: user.id },
  });
  await db.from("stripe_customers").upsert({ user_id: user.id, stripe_customer_id: cust.id });
  return cust.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const authz = req.headers.get("Authorization") ?? "";
  const bearer = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : null;
  const db = svc();
  const user = await userFromBearer(db, bearer);
  if (!user) return json({ error: "Sign in required.", need_signin: true }, 401);

  try {
    if (req.method === "GET") {
      const { data, error } = await db.rpc("get_billing_status", { p_user_id: user.id });
      if (error) throw new Error(error.message);
      return json(data);
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const action = (body.action ?? "checkout").toString();
      const site = Deno.env.get("SITE_URL") ?? (body.return_url as string) ??
        "https://signal-underwriting-c294.bolt.host";
      const st = stripe();
      const customerId = await getOrCreateCustomer(db, st, user);

      if (action === "checkout") {
        const planKey = (body.plan_key ?? "").toString();
        const { data: plan } = await db
          .from("plans").select("plan_key, stripe_price_id").eq("plan_key", planKey).maybeSingle();
        if (!plan) return json({ error: `Unknown plan '${planKey}'.` }, 400);
        if (!plan.stripe_price_id) {
          return json({ error: `Plan '${planKey}' has no Stripe price configured yet.` }, 400);
        }
        const session = await st.checkout.sessions.create({
          mode: "subscription",
          customer: customerId,
          line_items: [{ price: plan.stripe_price_id as string, quantity: 1 }],
          client_reference_id: user.id,
          subscription_data: { metadata: { user_id: user.id, plan_key: planKey } },
          success_url: `${site}/?checkout=success`,
          cancel_url: `${site}/?checkout=cancel`,
          allow_promotion_codes: true,
        });
        return json({ url: session.url });
      }

      if (action === "portal") {
        const session = await st.billingPortal.sessions.create({
          customer: customerId,
          return_url: site,
        });
        return json({ url: session.url });
      }

      return json({ error: `Unknown action '${action}'.` }, 400);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
