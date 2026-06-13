// Step 2 — Address validation (spec §5). Calls Google Geocoding (mocked until
// live). On success returns formatted_address + lat/lng + components. On failure
// raises a StepError carrying the spec's exact user-facing message; the pipeline
// then halts the job with status=failed, error_step=2.
import { logStep } from "../lib/db.ts";
import { StepError } from "../lib/errors.ts";
import { geocode, type GeocodeResult } from "../lib/google.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const FAIL_MESSAGE =
  "I couldn't verify that address. Can you double-check it and try again?";

export async function step2ValidateAddress(
  db: SupabaseClient,
  jobId: string,
  rawAddress: string,
): Promise<GeocodeResult> {
  const start = Date.now();
  const base = { job_id: jobId, step: 2, function_name: "validateAddress" } as const;

  let result: GeocodeResult | null;
  try {
    result = await geocode(rawAddress);
  } catch (e) {
    const detail = String((e as Error)?.message ?? e);
    await logStep(db, {
      ...base,
      status: "fail",
      input_payload: { rawAddress },
      error_message: detail,
      duration_ms: Date.now() - start,
    });
    throw new StepError(2, FAIL_MESSAGE, detail);
  }

  if (!result) {
    await logStep(db, {
      ...base,
      status: "fail",
      input_payload: { rawAddress },
      error_message: "Geocoding returned no results",
      duration_ms: Date.now() - start,
    });
    throw new StepError(2, FAIL_MESSAGE, "No geocode results");
  }

  await logStep(db, {
    ...base,
    status: "pass",
    input_payload: { rawAddress },
    output_payload: result,
    duration_ms: Date.now() - start,
  });
  return result;
}
