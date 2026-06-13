// Step 1 — Accept address (spec §5). One job only: take the free-text address
// from any caller, normalize whitespace, hand it to step 2. Logs to debug_log.
import { logStep, type DebugEntry } from "../lib/db.ts";
import { StepError } from "../lib/errors.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function step1AcceptAddress(
  db: SupabaseClient,
  jobId: string,
  rawAddress: string,
): Promise<{ address: string }> {
  const start = Date.now();
  const address = (rawAddress ?? "").toString().trim();

  const base: Pick<DebugEntry, "job_id" | "step" | "function_name"> = {
    job_id: jobId,
    step: 1,
    function_name: "acceptAddress",
  };

  if (!address) {
    await logStep(db, {
      ...base,
      status: "fail",
      input_payload: { rawAddress },
      error_message: "Empty address",
      duration_ms: Date.now() - start,
    });
    throw new StepError(1, "Please enter an address to underwrite.", "Empty address");
  }

  await logStep(db, {
    ...base,
    status: "pass",
    input_payload: { rawAddress },
    output_payload: { address },
    duration_ms: Date.now() - start,
  });
  return { address };
}
