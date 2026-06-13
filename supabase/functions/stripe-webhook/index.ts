// Signal UW — Stripe webhook. Keeps public.subscriptions in sync with Stripe and
// bills accrued overage on the next invoice. No JWT (Stripe calls it); instead we
// verify the Stripe signature. Deploy with verify_jwt = false.
//   Events handled:
//     checkout.session.completed            → link sub to user, sync row
//     customer.subscription.created/updated → sync plan/status/period
//     customer.subscription.deleted         → mark canceled
//     invoice.created (draft)               → attach unreported overage as invoice items
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import Stripe from "npm:stripe@16";

function svc(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}
function stripe(): Stripe {
  return new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
    httpClient: Stripe.createFetchHttpClient(),
  });
}

async function planKeyForPrice(db: SupabaseClient, priceId: string | null): Promise<string | null> {
  if (!priceId) return null;
  const { data } = await db.from("plans").select("plan_key").eq("stripe_price_id", priceId).maybeSingle();
  return (data?.plan_key as string) ?? null;
}

async function userIdForCustomer(db: SupabaseClient, customerId: string): Promise<string | null> {
  const { data } = await db
    .from("stripe_customers").select("user_id").eq("stripe_customer_id", customerId).maybeSingle();
  return (data?.user_id as string) ?? null;
}

// deno-lint-ignore no-explicit-any
async function upsertSubscription(db: SupabaseClient, sub: any): Promise<void> {
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;
  const planKey = (await planKeyForPrice(db, priceId)) ?? sub.metadata?.plan_key ?? null;
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  const userId = sub.metadata?.user_id ?? (customerId ? await userIdForCustomer(db, customerId) : null);
  if (!userId) {
    console.error("upsertSubscription: no user_id for subscription", sub.id);
    return;
  }
  const row: Record<string, unknown> = {
    user_id: userId,
    stripe_customer_id: customerId ?? null,
    stripe_subscription_id: sub.id,
    plan_key: planKey,
    status: sub.status,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };
  // Period dates live on the subscription in older API versions and on the
  // subscription item in newer ones (Basil+). Accept either.
  const item0 = sub.items?.data?.[0];
  const periodStart = sub.current_period_start ?? item0?.current_period_start ?? null;
  const periodEnd = sub.current_period_end ?? item0?.current_period_end ?? null;
  if (periodStart) row.current_period_start = new Date(periodStart * 1000).toISOString();
  if (periodEnd) row.current_period_end = new Date(periodEnd * 1000).toISOString();
  const { error } = await db.from("subscriptions").upsert(row, { onConflict: "user_id" });
  if (error) console.error("subscriptions upsert failed:", error.message);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const sig = req.headers.get("stripe-signature") ?? "";
  const whSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!whSecret) return new Response("Webhook secret not configured", { status: 500 });

  const raw = await req.text();
  const st = stripe();
  let event: Stripe.Event;
  try {
    event = await st.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    return new Response(`Bad signature: ${(e as Error).message}`, { status: 400 });
  }

  const db = svc();
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        // deno-lint-ignore no-explicit-any
        const s = event.data.object as any;
        if (s.subscription) {
          const sub = await st.subscriptions.retrieve(s.subscription as string);
          // Ensure the user link survives even if subscription metadata was empty.
          // deno-lint-ignore no-explicit-any
          const subAny = sub as any;
          if (s.client_reference_id && !subAny.metadata?.user_id) {
            subAny.metadata = { ...(subAny.metadata ?? {}), user_id: s.client_reference_id };
          }
          await upsertSubscription(db, subAny);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        // Re-fetch via the SDK so the row is built from the SDK's pinned API
        // version (stable shape: items[].price.id + current_period_*), instead
        // of trusting the endpoint's payload API version, which may omit those
        // fields on newer versions.
        // deno-lint-ignore no-explicit-any
        const evObj = event.data.object as any;
        let sub: unknown = evObj;
        try {
          if (evObj?.id) sub = await st.subscriptions.retrieve(evObj.id as string);
        } catch (e) {
          console.error("subscription retrieve failed, using event payload:", (e as Error).message);
        }
        await upsertSubscription(db, sub);
        break;
      }
      case "customer.subscription.deleted": {
        // deno-lint-ignore no-explicit-any
        const sub = event.data.object as any;
        await db.from("subscriptions")
          .update({ status: "canceled", cancel_at_period_end: false, updated_at: new Date().toISOString() })
          .eq("stripe_subscription_id", sub.id);
        break;
      }
      case "invoice.created": {
        // deno-lint-ignore no-explicit-any
        const inv = event.data.object as any;
        const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id;
        if (customerId && inv.status === "draft") {
          const { data: events } = await db
            .from("overage_events").select("*")
            .eq("stripe_customer_id", customerId).eq("reported_to_stripe", false);
          for (const ev of (events ?? [])) {
            const item = await st.invoiceItems.create({
              customer: customerId,
              invoice: inv.id,
              currency: "usd",
              amount: (ev.unit_amount_cents as number) * (ev.units as number),
              description: "Additional inquiry (overage)",
            });
            await db.from("overage_events")
              .update({ reported_to_stripe: true, stripe_invoice_item_id: item.id })
              .eq("id", ev.id);
          }
        }
        break;
      }
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("webhook handler error:", e);
    return new Response(`handler error: ${(e as Error).message}`, { status: 500 });
  }
});
