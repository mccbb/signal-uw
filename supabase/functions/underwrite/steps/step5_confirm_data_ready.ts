// Step 5 — Confirm all data written (spec §5). A pure internal gate (no external
// calls): verify a subject_properties row exists and BOTH avm_results rows (rent
// and sale) exist before proceeding to step 6. If anything is missing, halt the
// job with status=failed, error_step=5.
import { getDataReadiness, logStep } from "../lib/db.ts";
import { StepError } from "../lib/errors.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function step5ConfirmDataReady(
  db: SupabaseClient,
  jobId: string,
): Promise<void> {
  const start = Date.now();
  const base = { job_id: jobId, step: 5, function_name: "confirmDataReady" } as const;

  const r = await getDataReadiness(db, jobId);

  if (!r.ready) {
    const missing = [
      r.subjects < 1 ? "subject_properties" : null,
      r.rent < 1 ? "avm_results(rent)" : null,
      r.sale < 1 ? "avm_results(sale)" : null,
    ].filter(Boolean);
    await logStep(db, {
      ...base,
      status: "fail",
      output_payload: { ...r, missing },
      error_message: `Missing prerequisite data: ${missing.join(", ")}`,
      duration_ms: Date.now() - start,
    });
    throw new StepError(
      5,
      "Something went wrong assembling the data for this property. Please try again.",
      `Data not ready: ${JSON.stringify(r)}`,
    );
  }

  await logStep(db, {
    ...base,
    status: "pass",
    output_payload: r,
    duration_ms: Date.now() - start,
  });
}
