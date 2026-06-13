// Signal UW — /underwrite edge function (entrypoint / router).
//   POST /underwrite            { address }            → create a job (or cache hit)
//   GET  /underwrite?job_id=…                          → poll job / final report
//   GET  /underwrite?history=1  (x-signal-api-key)     → this user's saved history
// Per-user features key off the `x-signal-api-key` header (the Signal API key).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createUnderwriting, getHistory, getJobStatus } from "./pipeline.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-signal-api-key",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const apiKey = req.headers.get("x-signal-api-key");
  const authz = req.headers.get("Authorization") ?? "";
  const bearer = authz.toLowerCase().startsWith("bearer ") ? authz.slice(7).trim() : null;

  try {
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = await createUnderwriting(body, apiKey, bearer);
      return json(r.payload, r.httpStatus);
    }
    if (req.method === "GET") {
      const url = new URL(req.url);
      if (url.searchParams.has("history")) {
        const r = await getHistory(apiKey, bearer);
        return json(r.payload, r.httpStatus);
      }
      const r = await getJobStatus(url.searchParams.get("job_id"));
      return json(r.payload, r.httpStatus);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (e) {
    return json({ error: "Internal error", detail: String((e as Error)?.message ?? e) }, 500);
  }
});
