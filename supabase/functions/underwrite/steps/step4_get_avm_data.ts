// Step 4 — RentCast AVM pulls (spec §5). Two separate calls:
//   Call A — Rental AVM  (/avm/rent/long-term)
//   Call B — Sale AVM    (/avm/value)
// Each stored as an avm_results row with estimate, range, and the full comps
// array. Comp count is set to the max allowable (spec). One debug_log entry
// records both records and their comp counts.
import { insertAvmResult, logStep } from "../lib/db.ts";
import { StepError } from "../lib/errors.ts";
import { type AvmAttrs, type AvmResult, getAVM } from "../lib/rentcast.ts";
import type { GeocodeResult } from "../lib/google.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface SubjectAttrs {
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  property_type: string | null;
  lat: number | null;
  lng: number | null;
}

export async function step4GetAVMData(
  db: SupabaseClient,
  jobId: string,
  geo: GeocodeResult,
  subject: SubjectAttrs,
): Promise<{ rent: AvmResult; sale: AvmResult }> {
  const start = Date.now();
  const base = { job_id: jobId, step: 4, function_name: "getAVMData" } as const;

  const rentcastAddress = `${geo.street}, ${geo.city}, ${geo.state}, ${geo.zip}`;
  const attrs: AvmAttrs = {
    propertyType: subject.property_type,
    bedrooms: subject.beds,
    bathrooms: subject.baths,
    squareFootage: subject.sqft,
    latitude: subject.lat,
    longitude: subject.lng,
  };

  let rent: AvmResult;
  let sale: AvmResult;
  try {
    // Call A — rental AVM, Call B — sale AVM
    rent = await getAVM("rent", rentcastAddress, attrs);
    sale = await getAVM("sale", rentcastAddress, attrs);
  } catch (e) {
    const detail = String((e as Error)?.message ?? e);
    await logStep(db, {
      ...base,
      status: "fail",
      input_payload: { rentcastAddress, attrs },
      error_message: detail,
      duration_ms: Date.now() - start,
    });
    throw new StepError(4, "I couldn't pull valuation data for that address. Please try again.", detail);
  }

  // Persist both AVM records.
  await insertAvmResult(db, jobId, {
    avm_type: "rent",
    estimate: rent.estimate,
    range_low: rent.range_low,
    range_high: rent.range_high,
    comps_json: rent.comps,
  });
  await insertAvmResult(db, jobId, {
    avm_type: "sale",
    estimate: sale.estimate,
    range_low: sale.range_low,
    range_high: sale.range_high,
    comps_json: sale.comps,
  });

  await logStep(db, {
    ...base,
    status: "pass",
    input_payload: { rentcastAddress, attrs },
    output_payload: {
      rent: { estimate: rent.estimate, range_low: rent.range_low, range_high: rent.range_high, comp_count: rent.comps.length },
      sale: { estimate: sale.estimate, range_low: sale.range_low, range_high: sale.range_high, comp_count: sale.comps.length },
    },
    duration_ms: Date.now() - start,
  });

  return { rent, sale };
}
