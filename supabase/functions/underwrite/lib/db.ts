// Database access via the service-role key (bypasses RLS — see migration 0002).
// Also home to the mandatory debug_log writer (spec rule §3.5).
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export function getServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function createJob(
  db: SupabaseClient,
  fields: { address_raw: string; user_id: string | null },
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("jobs")
    .insert({ address_raw: fields.address_raw, user_id: fields.user_id, status: "queued" })
    .select("id")
    .single();
  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data as { id: string };
}

export async function updateJob(
  db: SupabaseClient,
  id: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const patch = { ...fields };
  if (patch.status === "complete" && !patch.completed_at) {
    patch.completed_at = new Date().toISOString();
  }
  const { error } = await db.from("jobs").update(patch).eq("id", id);
  if (error) throw new Error(`updateJob failed: ${error.message}`);
}

// The polling view returned by GET ?job_id=. Expands as later steps add results.
export async function getJobView(
  db: SupabaseClient,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db.from("jobs").select("*").eq("id", jobId).maybeSingle();
  if (error) throw new Error(`getJobView failed: ${error.message}`);
  if (!data) return null;
  return {
    job_id: data.id,
    status: data.status,
    current_step: data.current_step,
    address: data.address_formatted ?? data.address_raw,
    error_step: data.error_step,
    error_message: data.error_message,
    created_at: data.created_at,
    completed_at: data.completed_at,
  };
}

// Insert the step-3 subject property record and return its id (referenced by
// later steps). raw_json keeps the full RentCast response.
export async function insertSubjectProperty(
  db: SupabaseClient,
  jobId: string,
  subject: Record<string, unknown>,
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("subject_properties")
    .insert({ job_id: jobId, ...subject })
    .select("id")
    .single();
  if (error) throw new Error(`insertSubjectProperty failed: ${error.message}`);
  return data as { id: string };
}

// Insert one step-4 AVM result row (rent or sale). comps_json holds the full
// RentCast comparables array.
export async function insertAvmResult(
  db: SupabaseClient,
  jobId: string,
  avm: {
    avm_type: "rent" | "sale";
    estimate: number | null;
    range_low: number | null;
    range_high: number | null;
    comps_json: unknown;
  },
): Promise<{ id: string }> {
  const { data, error } = await db
    .from("avm_results")
    .insert({ job_id: jobId, ...avm })
    .select("id")
    .single();
  if (error) throw new Error(`insertAvmResult failed: ${error.message}`);
  return data as { id: string };
}

// Fetch the subject_properties row for a job (step 6 needs subject attrs).
export async function getSubjectProperty(
  db: SupabaseClient,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("subject_properties")
    .select("*")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`getSubjectProperty failed: ${error.message}`);
  return data ?? null;
}

// Fetch the comps array stored on an avm_results row (rent or sale).
export async function getAvmComps(
  db: SupabaseClient,
  jobId: string,
  avmType: "rent" | "sale",
): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from("avm_results")
    .select("comps_json")
    .eq("job_id", jobId)
    .eq("avm_type", avmType)
    .maybeSingle();
  if (error) throw new Error(`getAvmComps failed: ${error.message}`);
  const comps = data?.comps_json;
  return Array.isArray(comps) ? comps as Record<string, unknown>[] : [];
}

// Fetch all comp_scores rows for a pool (step 7 reads these, incl. excluded).
export async function getCompScores(
  db: SupabaseClient,
  jobId: string,
  avmType: "rent" | "sale",
): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from("comp_scores")
    .select("*")
    .eq("job_id", jobId)
    .eq("avm_type", avmType);
  if (error) throw new Error(`getCompScores failed: ${error.message}`);
  return data ?? [];
}

// Fetch an AVM result's estimate/range (step 7 fallback flag, step 8 fallback).
export async function getAvmEstimate(
  db: SupabaseClient,
  jobId: string,
  avmType: "rent" | "sale",
): Promise<{ estimate: number | null; range_low: number | null; range_high: number | null } | null> {
  const { data, error } = await db
    .from("avm_results")
    .select("estimate, range_low, range_high")
    .eq("job_id", jobId)
    .eq("avm_type", avmType)
    .maybeSingle();
  if (error) throw new Error(`getAvmEstimate failed: ${error.message}`);
  return data ?? null;
}

// Insert a step-7 ai_comp_results row (one per pool).
export async function insertAiCompResult(
  db: SupabaseClient,
  jobId: string,
  row: {
    avm_type: "rent" | "sale";
    final_comps_json: unknown;
    excluded_high_json: unknown;
    excluded_low_json: unknown;
    data_quality: "ok" | "low" | "none";
    quality_meta: unknown;
  },
): Promise<void> {
  const { error } = await db.from("ai_comp_results").insert({ job_id: jobId, ...row });
  if (error) throw new Error(`insertAiCompResult failed: ${error.message}`);
}

// Fetch a step-7 ai_comp_results row for a pool (step 8 reads the final comps).
export async function getAiCompResult(
  db: SupabaseClient,
  jobId: string,
  avmType: "rent" | "sale",
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("ai_comp_results")
    .select("final_comps_json, excluded_high_json, excluded_low_json, data_quality, quality_meta")
    .eq("job_id", jobId)
    .eq("avm_type", avmType)
    .maybeSingle();
  if (error) throw new Error(`getAiCompResult failed: ${error.message}`);
  return data ?? null;
}

// Count all comp_scores rows for a job (report's "comps_analyzed").
export async function countCompScores(db: SupabaseClient, jobId: string): Promise<number> {
  const { count, error } = await db
    .from("comp_scores")
    .select("id", { count: "exact", head: true })
    .eq("job_id", jobId);
  if (error) throw new Error(`countCompScores failed: ${error.message}`);
  return count ?? 0;
}

// Insert the step-8 underwriting_results row (final ARV/rent + comps + report).
export async function insertUnderwritingResult(
  db: SupabaseClient,
  jobId: string,
  row: {
    arv: number | null;
    estimated_rent: number | null;
    sale_comps_json: unknown;
    rent_comps_json: unknown;
    report_json: unknown;
  },
): Promise<void> {
  const { error } = await db.from("underwriting_results").insert({ job_id: jobId, ...row });
  if (error) throw new Error(`insertUnderwritingResult failed: ${error.message}`);
}

// Fetch the assembled report (GET return when status=complete).
export async function getReportJson(
  db: SupabaseClient,
  jobId: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from("underwriting_results")
    .select("report_json")
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) throw new Error(`getReportJson failed: ${error.message}`);
  return (data?.report_json as Record<string, unknown>) ?? null;
}

// Bulk-insert step-6 comp_scores rows.
export async function insertCompScores(
  db: SupabaseClient,
  rows: Record<string, unknown>[],
): Promise<void> {
  if (!rows.length) return;
  const { error } = await db.from("comp_scores").insert(rows);
  if (error) throw new Error(`insertCompScores failed: ${error.message}`);
}

// Cost failsafe: atomically consume one live-run from the budget. Returns true
// if the run is allowed, false if the circuit breaker has tripped (budget
// exhausted or hard_stop). Only called in live mode.
export async function consumeLiveBudget(db: SupabaseClient): Promise<boolean> {
  const { data, error } = await db.rpc("consume_live_run");
  if (error) throw new Error(`consumeLiveBudget failed: ${error.message}`);
  return data === true;
}

// 7-day per-user cache: most recent saved report for this user + address within
// the window, or null. Used before running to avoid re-charging repeats.
export async function findCachedReport(
  db: SupabaseClient,
  userId: string,
  addressKey: string,
  windowDays = 7,
): Promise<{ report_json: Record<string, unknown>; job_id: string | null; created_at: string } | null> {
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db
    .from("underwritings")
    .select("report_json, job_id, created_at")
    .eq("user_id", userId)
    .eq("address_key", addressKey)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`findCachedReport failed: ${error.message}`);
  if (!data?.report_json) return null;
  return data as { report_json: Record<string, unknown>; job_id: string | null; created_at: string };
}

// Permanent per-user history write (also what the cache reads).
export async function insertUnderwritingHistory(
  db: SupabaseClient,
  row: {
    user_id: string;
    job_id: string;
    address: string | null;
    address_key: string;
    report_json: unknown;
    verdict?: string | null;
  },
): Promise<void> {
  const { error } = await db.from("underwritings").insert(row);
  if (error) console.error("insertUnderwritingHistory failed:", error.message);
}

// List a user's saved underwritings (newest first) for the history endpoint.
export async function listUnderwritings(
  db: SupabaseClient,
  userId: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await db
    .from("underwritings")
    .select("id, job_id, address, verdict, created_at, report_json")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`listUnderwritings failed: ${error.message}`);
  return (data ?? []).map((r) => {
    const rep = (r.report_json ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      job_id: r.job_id,
      address: r.address,
      created_at: r.created_at,
      arv: rep.arv ?? null,
      estimated_rent: rep.estimated_rent ?? null,
    };
  });
}

// Free-trial gate (signed-in): how many reports this user has run (= saved
// underwritings). Repeats served from cache don't add a row, so they don't count.
export async function countUserUnderwritings(db: SupabaseClient, userId: string): Promise<number> {
  const { count, error } = await db
    .from("underwritings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  if (error) throw new Error(`countUserUnderwritings failed: ${error.message}`);
  return count ?? 0;
}

// Metering gate — decide if this user may run now, and whether the run is an
// overage unit. Returns the jsonb shape from public.check_run_allowance():
//   { allowed, reason, plan_key, used, inquiry_limit, is_overage, period_*, overage_cents }
// reason ∈ within_plan | overage | limit_reached | trial | trial_exhausted
export interface Allowance {
  allowed: boolean;
  reason: string;
  plan_key: string | null;
  used: number;
  inquiry_limit: number;
  is_overage: boolean;
  period_end?: string | null;
}
export async function checkRunAllowance(db: SupabaseClient, userId: string): Promise<Allowance> {
  const { data, error } = await db.rpc("check_run_allowance", { p_user_id: userId });
  if (error) throw new Error(`checkRunAllowance failed: ${error.message}`);
  return data as Allowance;
}

// Log one overage unit for a completed run (no-op if the user has no overage plan).
export async function recordOverage(db: SupabaseClient, userId: string, jobId: string): Promise<void> {
  const { error } = await db.rpc("record_overage", { p_user_id: userId, p_job_id: jobId });
  if (error) console.error("recordOverage failed:", error.message);
}

// (Legacy) email-based lead capture — retained for reference; not used now that
// runs require sign-in.
export async function countLeadsByEmail(db: SupabaseClient, email: string): Promise<number> {
  const { count, error } = await db
    .from("leads")
    .select("id", { count: "exact", head: true })
    .eq("email", email);
  if (error) throw new Error(`countLeadsByEmail failed: ${error.message}`);
  return count ?? 0;
}

export async function insertLead(db: SupabaseClient, email: string, address: string): Promise<void> {
  const { error } = await db.from("leads").insert({ email, address });
  if (error) console.error("insertLead failed:", error.message);
}

export interface DataReadiness {
  subjects: number;
  rent: number;
  sale: number;
  ready: boolean;
}

export async function getDataReadiness(
  db: SupabaseClient,
  jobId: string,
): Promise<DataReadiness> {
  const countRows = async (table: string, extra?: { col: string; val: string }) => {
    let q = db.from(table).select("id", { count: "exact", head: true }).eq("job_id", jobId);
    if (extra) q = q.eq(extra.col, extra.val);
    const { count, error } = await q;
    if (error) throw new Error(`readiness count(${table}) failed: ${error.message}`);
    return count ?? 0;
  };

  const subjects = await countRows("subject_properties");
  const rent = await countRows("avm_results", { col: "avm_type", val: "rent" });
  const sale = await countRows("avm_results", { col: "avm_type", val: "sale" });

  return { subjects, rent, sale, ready: subjects >= 1 && rent >= 1 && sale >= 1 };
}

export interface DebugEntry {
  job_id: string;
  step: number;
  function_name: string;
  status: "pass" | "fail";
  input_payload?: unknown;
  output_payload?: unknown;
  error_message?: string;
  duration_ms?: number;
}

// Mandatory: every step writes one debug_log row. Never throws — logging must
// not break the pipeline; failures are surfaced to the function logs instead.
export async function logStep(db: SupabaseClient, entry: DebugEntry): Promise<void> {
  const { error } = await db.from("debug_log").insert({
    job_id: entry.job_id,
    step: entry.step,
    function_name: entry.function_name,
    status: entry.status,
    input_payload: entry.input_payload ?? null,
    output_payload: entry.output_payload ?? null,
    error_message: entry.error_message ?? null,
    duration_ms: entry.duration_ms ?? null,
  });
  if (error) console.error("debug_log insert failed:", error.message);
}
