// Signal UW — /keys edge function. Account-page API-key management for the
// Signal MCP. Requires a logged-in Supabase session (Authorization: Bearer).
//   POST /keys            { label? }            → mint a new key (raw key returned ONCE)
//   POST /keys            { action:"revoke", id }→ revoke one of your keys
//   GET  /keys                                   → list your keys (no raw secret)
// Keys are stored only as a SHA-256 hash (see migration 0006); the raw value is
// shown a single time at creation and never persisted.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

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

function serviceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

// Resolve the logged-in user from their Supabase session token. Returns null for
// anonymous / anon-key / invalid tokens (we then reject — key management is
// always authenticated).
async function userFromBearer(db: SupabaseClient, bearer: string | null): Promise<string | null> {
  if (!bearer) return null;
  if (bearer === (Deno.env.get("SUPABASE_ANON_KEY") ?? "")) return null;
  const { data, error } = await db.auth.getUser(bearer);
  if (error || !data?.user?.id) return null;
  return data.user.id;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const db = serviceClient();
  const authz = req.headers.get("Authorization") ?? "";
  const bearer = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : null;
  const userId = await userFromBearer(db, bearer);
  if (!userId) return json({ error: "Sign in required" }, 401);

  try {
    if (req.method === "GET") {
      const { data, error } = await db
        .from("api_keys")
        .select("id, key_prefix, label, created_at, last_used_at, revoked")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return json({ keys: data ?? [] });
    }

    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));

      // Revoke one of the caller's keys.
      if (body?.action === "revoke") {
        if (!body?.id) return json({ error: "Missing key id" }, 400);
        const { error } = await db
          .from("api_keys")
          .update({ revoked: true })
          .eq("id", body.id)
          .eq("user_id", userId); // owner-scoped
        if (error) throw error;
        return json({ ok: true, revoked: body.id });
      }

      // Mint a new key for the caller.
      const label = typeof body?.label === "string" ? body.label.slice(0, 80) : null;
      const { data, error } = await db.rpc("mint_api_key", { p_user_id: userId, p_label: label });
      if (error) throw error;
      const rawKey = String(data);
      return json({ api_key: rawKey, key_prefix: rawKey.slice(0, 12), label }, 201);
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: "Internal error", detail: String((e as Error)?.message ?? e) }, 500);
  }
});
