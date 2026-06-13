// Pipeline orchestrator. Runs the full engine (steps 1–8) with a live-run cost
// failsafe. Per-user features (MCP identity via Signal API key):
//   • 7-day cache — if this user already underwrote this address in the last
//     7 days, return the saved report instead of re-running (free, instant).
//   • permanent history — every completed underwrite is saved to the user's
//     `underwritings` drawer (which is also what the cache reads).
import {
  checkRunAllowance,
  consumeLiveBudget,
  createJob,
  findCachedReport,
  getJobView,
  getReportJson,
  getServiceClient,
  insertUnderwritingHistory,
  listUnderwritings,
  recordOverage,
  updateJob,
} from "./lib/db.ts";
import { normalizeAddressKey, resolveIdentity } from "./lib/auth.ts";
import { StepError } from "./lib/errors.ts";
import { step1AcceptAddress } from "./steps/step1_accept_address.ts";
import { step2ValidateAddress } from "./steps/step2_validate_address.ts";
import { step3GetPropertyData } from "./steps/step3_get_property_data.ts";
import { step4GetAVMData } from "./steps/step4_get_avm_data.ts";
import { step5ConfirmDataReady } from "./steps/step5_confirm_data_ready.ts";
import { step6ScoreComps } from "./steps/step6_score_comps.ts";
import { step7RefineComps } from "./steps/step7_refine_comps.ts";
import { step8CalculateResults } from "./steps/step8_calculate_results.ts";

interface Reply {
  httpStatus: number;
  payload: Record<string, unknown>;
}

export async function createUnderwriting(
  body: Record<string, unknown>,
  apiKey: string | null,
  bearer: string | null,
): Promise<Reply> {
  const rawAddress = (body?.address ?? "").toString();
  if (!rawAddress.trim()) {
    return { httpStatus: 400, payload: { error: "Missing required field: address" } };
  }

  const db = getServiceClient();
  const auth = await resolveIdentity(db, { apiKey, bearer });
  if (auth.invalid) return { httpStatus: 401, payload: { error: "Invalid API key" } };
  const userId = auth.userId;

  // Every run requires a signed-in identity — Google sign-in on the website, or
  // a Signal API key for MCP. No anonymous runs.
  if (!userId) {
    return {
      httpStatus: 401,
      payload: { error: "Sign in to run a report.", need_signin: true },
    };
  }

  // 7-day per-user cache — repeats are free and never consume the trial.
  const addressKey = normalizeAddressKey(rawAddress);
  const cached = await findCachedReport(db, userId, addressKey);
  if (cached) {
    return {
      httpStatus: 200,
      payload: { ...cached.report_json, cached: true, cached_at: cached.created_at },
    };
  }

  // Metering. No active subscription → lifetime free trial (2). With a plan →
  // count completed reports in the current Stripe billing period vs the plan
  // limit; Institution may run past its limit (each extra run logged as a
  // $1.00 overage unit), Casual/Investor are hard-capped until renewal/upgrade.
  const allowance = await checkRunAllowance(db, userId);
  if (!allowance.allowed) {
    if (allowance.reason === "trial_exhausted") {
      return {
        httpStatus: 402,
        payload: {
          error: "You've used your free reports. Subscribe to keep underwriting.",
          trial_exhausted: true,
          free_limit: allowance.inquiry_limit,
        },
      };
    }
    // limit_reached — paid plan with no overage (Casual / Investor).
    return {
      httpStatus: 402,
      payload: {
        error: "You've used all the inquiries in your plan for this period. Upgrade or wait for renewal.",
        limit_reached: true,
        plan_key: allowance.plan_key,
        inquiry_limit: allowance.inquiry_limit,
        period_end: allowance.period_end ?? null,
      },
    };
  }
  const isOverage = allowance.is_overage === true;

  const job = await createJob(db, { address_raw: rawAddress, user_id: userId });

  const task = runPipeline(db, job.id, rawAddress, userId, isOverage);
  // deno-lint-ignore no-explicit-any
  const er = (globalThis as any).EdgeRuntime;
  if (er?.waitUntil) er.waitUntil(task);
  else await task;

  return { httpStatus: 202, payload: { job_id: job.id, status: "queued" } };
}

export async function getJobStatus(jobId: string | null): Promise<Reply> {
  if (!jobId) return { httpStatus: 400, payload: { error: "Missing job_id query param" } };
  const db = getServiceClient();
  const view = await getJobView(db, jobId);
  if (!view) return { httpStatus: 404, payload: { error: "Job not found" } };
  if (view.status === "complete") {
    const report = await getReportJson(db, jobId);
    if (report) return { httpStatus: 200, payload: report };
  }
  return { httpStatus: 200, payload: view };
}

// History endpoint: list this user's saved underwritings (API key or session).
export async function getHistory(apiKey: string | null, bearer: string | null): Promise<Reply> {
  const db = getServiceClient();
  const auth = await resolveIdentity(db, { apiKey, bearer });
  if (auth.invalid) return { httpStatus: 401, payload: { error: "Invalid API key" } };
  if (!auth.userId) return { httpStatus: 401, payload: { error: "Sign in to view your history" } };
  const items = await listUnderwritings(db, auth.userId);
  return { httpStatus: 200, payload: { underwritings: items } };
}

async function runPipeline(
  db: ReturnType<typeof getServiceClient>,
  jobId: string,
  rawAddress: string,
  userId: string | null,
  isOverage = false,
): Promise<void> {
  try {
    const liveMode = Deno.env.get("MOCK_EXTERNAL") === "false";
    if (liveMode) {
      const allowed = await consumeLiveBudget(db);
      if (!allowed) {
        throw new StepError(
          0,
          "This run was paused by the cost failsafe (live-run budget reached). No external API calls were made. Reset or raise the budget to continue.",
          "live_guard blocked",
        );
      }
    }

    await updateJob(db, jobId, { status: "running", current_step: 1 });
    const accepted = await step1AcceptAddress(db, jobId, rawAddress);

    await updateJob(db, jobId, { current_step: 2 });
    const validated = await step2ValidateAddress(db, jobId, accepted.address);
    await updateJob(db, jobId, { address_formatted: validated.formatted_address });

    await updateJob(db, jobId, { current_step: 3 });
    const { subject } = await step3GetPropertyData(db, jobId, validated);

    await updateJob(db, jobId, { current_step: 4 });
    await step4GetAVMData(db, jobId, validated, {
      sqft: subject.sqft,
      beds: subject.beds,
      baths: subject.baths,
      property_type: subject.property_type,
      lat: subject.lat,
      lng: subject.lng,
    });

    await updateJob(db, jobId, { current_step: 5 });
    await step5ConfirmDataReady(db, jobId);

    await updateJob(db, jobId, { current_step: 6 });
    await step6ScoreComps(db, jobId, {
      sqft: subject.sqft,
      beds: subject.beds,
      baths: subject.baths,
      year_built: subject.year_built,
      lot_size_acres: subject.lot_size_acres,
      lat: subject.lat,
      lng: subject.lng,
    });

    await updateJob(db, jobId, { current_step: 7 });
    await step7RefineComps(db, jobId, {
      address: subject.address,
      property_type: subject.property_type,
      sqft: subject.sqft,
      beds: subject.beds,
      baths: subject.baths,
      year_built: subject.year_built,
      lot_size_acres: subject.lot_size_acres,
      garage: subject.garage,
      pool: subject.pool,
      lat: subject.lat,
      lng: subject.lng,
    });

    await updateJob(db, jobId, { current_step: 8 });
    await step8CalculateResults(
      db,
      jobId,
      { address: subject.address, sqft: subject.sqft },
      validated.formatted_address,
    );

    // Per-user permanent history (also powers the 7-day cache). Anonymous jobs
    // are not saved to any user's drawer.
    if (userId) {
      const report = await getReportJson(db, jobId);
      await insertUnderwritingHistory(db, {
        user_id: userId,
        job_id: jobId,
        address: (report?.address as string) ?? validated.formatted_address ?? null,
        address_key: normalizeAddressKey(rawAddress),
        report_json: report,
        verdict: null,
      });
      // If this run exceeded the plan limit (Institution overage), log a $1.00
      // unit to be billed on the next invoice.
      if (isOverage) await recordOverage(db, userId, jobId);
    }
  } catch (err) {
    const step = err instanceof StepError ? err.step : null;
    const userMessage =
      err instanceof StepError ? err.userMessage : (err as Error)?.message ?? String(err);
    await updateJob(db, jobId, {
      status: "failed",
      error_step: step,
      error_message: userMessage,
    }).catch((e) => console.error("failed to mark job failed:", e));
  }
}
