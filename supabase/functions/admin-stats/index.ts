// Signal UW — admin-stats. Owner-only usage dashboard data source.
// verify_jwt = true: the platform verifies the caller's session JWT. We then
// confirm the caller is the owner (OWNER_USER_ID) before returning anything.
//
// Returns backend metrics from public.admin_overview() always, plus a PostHog
// traffic summary (visits / video / demo / bounces) if PostHog env is set.
//
// Env (Supabase → Edge Functions → Secrets):
//   OWNER_USER_ID        required — your auth.users UUID (only this user may read)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  (already set)
//   POSTHOG_PROJECT_ID   optional — numeric project id
//   POSTHOG_API_KEY      optional — personal API key (phx_...)
//   POSTHOG_HOST         optional — defaults to https://us.posthog.com
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function posthogSummary(days: number) {
  const pid = Deno.env.get("POSTHOG_PROJECT_ID");
  const key = Deno.env.get("POSTHOG_API_KEY");
  if (!pid || !key) return null;
  const host = Deno.env.get("POSTHOG_HOST") ?? "https://us.posthog.com";

  // HogQL: pageviews, unique visitors, video plays, demo starts, demo completes,
  // and a crude bounce proxy (sessions with a single pageview).
  const query = `
    select
      countIf(event = '$pageview')                                   as pageviews,
      count(distinct person_id)                                      as unique_visitors,
      countIf(event = 'video_played')                                as video_plays,
      countIf(event = 'demo_started')                                as demo_starts,
      countIf(event = 'demo_completed')                              as demo_completes
    from events
    where timestamp >= now() - interval ${days} day`;

  const bounceQuery = `
    select
      countIf(pv = 1) as bounced_sessions,
      count()         as total_sessions
    from (
      select "$session_id" as sid, countIf(event = '$pageview') as pv
      from events
      where timestamp >= now() - interval ${days} day and "$session_id" != ''
      group by sid
    )`;

  async function run(q: string) {
    const r = await fetch(`${host}/api/projects/${pid}/query/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query: q } }),
    });
    if (!r.ok) throw new Error(`posthog ${r.status}: ${await r.text()}`);
    const d = await r.json();
    return d.results?.[0] ?? [];
  }

  try {
    const [m, b] = await Promise.all([run(query), run(bounceQuery)]);
    const bounced = Number(b?.[0] ?? 0);
    const sessions = Number(b?.[1] ?? 0);
    return {
      pageviews: m?.[0] ?? 0,
      unique_visitors: m?.[1] ?? 0,
      video_plays: m?.[2] ?? 0,
      demo_starts: m?.[3] ?? 0,
      demo_completes: m?.[4] ?? 0,
      sessions,
      bounced_sessions: bounced,
      bounce_rate: sessions ? Math.round((bounced / sessions) * 100) : null,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const owner = Deno.env.get("OWNER_USER_ID");
  if (!owner) return json({ error: "OWNER_USER_ID not configured" }, 500);

  // Identify the caller from their bearer token.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) return json({ error: "Unauthorized" }, 401);
  if (user.id !== owner) return json({ error: "Forbidden" }, 403);

  const url = new URL(req.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 365);

  // Backend metrics via service role.
  const svc = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
  const { data: overview, error: rpcErr } = await svc.rpc("admin_overview", { p_days: days });
  if (rpcErr) return json({ error: rpcErr.message }, 500);

  const traffic = await posthogSummary(days);

  return json({ backend: overview, traffic });
});
