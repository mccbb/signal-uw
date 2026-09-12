// Signal UW — notify-owner. Fired by Postgres triggers (public.notify_owner via
// pg_net) whenever someone captures an email ("test it out") or signs up.
// Sends the alert to Slack (incoming webhook) and ntfy (phone push).
//
// No JWT: the DB calls it. Instead it checks a shared secret header
// (x-notify-secret) against the WEBHOOK_SECRET env. Deploy with verify_jwt = false.
//
// Env (set in Supabase → Edge Functions → Secrets):
//   WEBHOOK_SECRET    required — must match the Vault 'notify_secret'
//   SLACK_WEBHOOK_URL optional — https://hooks.slack.com/services/...
//   NTFY_URL          optional — full topic URL, e.g. https://ntfy.sh/signal-uw-mac-9f3k
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

type EventBody = { event: string; data: Record<string, unknown> };

function fmt(event: string, d: Record<string, unknown>): { title: string; body: string } {
  if (event === "signup") {
    return {
      title: "🟢 New Signal signup",
      body: `${d.email ?? "(no email)"} via ${d.provider ?? "unknown"}`,
    };
  }
  if (event === "lead") {
    return {
      title: "✉️ New Signal lead (tried it out)",
      body: `${d.email ?? "(no email)"}${d.address ? ` — ${d.address}` : ""}`,
    };
  }
  return { title: `Signal event: ${event}`, body: JSON.stringify(d) };
}

async function postSlack(url: string, title: string, body: string) {
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `*${title}*\n${body}` }),
  });
}

async function postNtfy(url: string, title: string, body: string) {
  await fetch(url, {
    method: "POST",
    headers: { Title: title, Priority: "default", Tags: "bell" },
    body,
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const expected = Deno.env.get("WEBHOOK_SECRET");
  if (!expected || req.headers.get("x-notify-secret") !== expected) {
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: EventBody;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const { title, body } = fmt(payload.event, payload.data ?? {});
  const slack = Deno.env.get("SLACK_WEBHOOK_URL");
  const ntfy = Deno.env.get("NTFY_URL");

  const jobs: Promise<unknown>[] = [];
  if (slack) jobs.push(postSlack(slack, title, body).catch((e) => console.error("slack", e)));
  if (ntfy) jobs.push(postNtfy(ntfy, title, body).catch((e) => console.error("ntfy", e)));
  await Promise.all(jobs);

  return new Response(JSON.stringify({ ok: true, sent: jobs.length }), {
    headers: { "Content-Type": "application/json" },
  });
});
