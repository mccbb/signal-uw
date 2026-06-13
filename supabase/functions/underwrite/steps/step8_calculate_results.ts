// Step 8 — ARV and rent calculation (spec §5). For each pool, take the mean
// price-per-sqft of the 5 final comps and multiply by the subject sqft:
//   ARV  = mean(sale comp $/sqft)  × subject sqft
//   rent = mean(rent comp $/sqft)  × subject sqft
// Stores the final values + the assembled caller report, then marks the job
// complete. Spec §8: do NOT compute cap rate / DSCR / cash flow / verdict.
//
// Range: the automated valuation's proportional spread re-centered on our point
// estimate, so the range always brackets the number shown. When a pool was
// flagged low/none quality (use_avm_fallback), the headline value and range come
// straight from the automated valuation estimate for that side. The data source
// is never named in the report.
import {
  countCompScores,
  getAiCompResult,
  getAvmEstimate,
  insertUnderwritingResult,
  logStep,
  updateJob,
} from "../lib/db.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

interface SideResult {
  value: number | null;
  range_low: number | null;
  range_high: number | null;
  method: "comp_derived" | "fallback_low_quality" | "fallback_no_comps";
  mean_per_sqft: number | null;
  comps_used: number;
}

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const roundTo = (x: number | null, step: number): number | null =>
  x === null ? null : Math.round(x / step) * step;

function computeSide(
  ai: Record<string, unknown> | null,
  avm: { estimate: number | null; range_low: number | null; range_high: number | null } | null,
  subjectSqft: number | null,
): SideResult {
  const finals = Array.isArray(ai?.final_comps_json) ? ai!.final_comps_json as Record<string, unknown>[] : [];
  const ppsf = finals
    .map((c) => c.price_per_sqft)
    .filter((v): v is number => typeof v === "number" && v > 0);

  const meta = (ai?.quality_meta ?? {}) as Record<string, unknown>;
  const wantFallback = meta.use_avm_fallback === true;
  const canCompDerive = !wantFallback && ppsf.length > 0 && typeof subjectSqft === "number" && subjectSqft > 0;

  if (canCompDerive) {
    const mean = avg(ppsf);
    const value = mean * (subjectSqft as number);
    let low: number | null = null;
    let high: number | null = null;
    if (avm && typeof avm.estimate === "number" && avm.estimate > 0) {
      if (typeof avm.range_low === "number") low = value * (avm.range_low / avm.estimate);
      if (typeof avm.range_high === "number") high = value * (avm.range_high / avm.estimate);
    }
    return {
      value,
      range_low: low,
      range_high: high,
      method: "comp_derived",
      mean_per_sqft: mean,
      comps_used: ppsf.length,
    };
  }

  // Fallback: lead with the automated valuation estimate + its own range.
  return {
    value: avm?.estimate ?? null,
    range_low: avm?.range_low ?? null,
    range_high: avm?.range_high ?? null,
    method: ai?.data_quality === "none" ? "fallback_no_comps" : "fallback_low_quality",
    mean_per_sqft: null,
    comps_used: ppsf.length,
  };
}

export async function step8CalculateResults(
  db: SupabaseClient,
  jobId: string,
  subject: { address: string | null; sqft: number | null },
  addressFormatted: string | null,
): Promise<void> {
  const start = Date.now();
  const base = { job_id: jobId, step: 8, function_name: "calculateResults" } as const;

  const [saleAi, rentAi, saleAvm, rentAvm, compsAnalyzed] = await Promise.all([
    getAiCompResult(db, jobId, "sale"),
    getAiCompResult(db, jobId, "rent"),
    getAvmEstimate(db, jobId, "sale"),
    getAvmEstimate(db, jobId, "rent"),
    countCompScores(db, jobId),
  ]);

  const sale = computeSide(saleAi, saleAvm, subject.sqft);
  const rent = computeSide(rentAi, rentAvm, subject.sqft);

  const arv = roundTo(sale.value, 100);
  const estimated_rent = roundTo(rent.value, 5);

  const saleComps = Array.isArray(saleAi?.final_comps_json) ? saleAi!.final_comps_json : [];
  const rentComps = Array.isArray(rentAi?.final_comps_json) ? rentAi!.final_comps_json : [];

  // Transparency notes — never name the data source.
  const notes: string[] = [];
  if (sale.method !== "comp_derived") {
    notes.push("Comparable sale data was limited for this property; the value shown leads with an automated valuation estimate, with the best-available comps included for reference.");
  }
  if (rent.method !== "comp_derived") {
    notes.push("Comparable rental data was limited for this property; the rent shown leads with an automated valuation estimate, with the best-available comps included for reference.");
  }
  if (sale.method === "comp_derived" && rent.method === "comp_derived") {
    notes.push("ARV and rent are derived from the final comparable sets.");
  }

  const report = {
    job_id: jobId,
    status: "complete",
    address: addressFormatted ?? subject.address,
    arv,
    arv_range_low: roundTo(sale.range_low, 100),
    arv_range_high: roundTo(sale.range_high, 100),
    estimated_rent,
    rent_range_low: roundTo(rent.range_low, 5),
    rent_range_high: roundTo(rent.range_high, 5),
    comps_analyzed: compsAnalyzed,
    final_comps_used: saleComps.length + rentComps.length,
    sale_comps: saleComps,
    rent_comps: rentComps,
    data_quality: {
      sale: (saleAi?.data_quality as string) ?? null,
      rent: (rentAi?.data_quality as string) ?? null,
    },
    method: { sale: sale.method, rent: rent.method },
    notes,
  };

  await insertUnderwritingResult(db, jobId, {
    arv,
    estimated_rent,
    sale_comps_json: saleComps,
    rent_comps_json: rentComps,
    report_json: report,
  });

  await updateJob(db, jobId, { status: "complete", current_step: 8 });

  await logStep(db, {
    ...base,
    status: "pass",
    output_payload: {
      arv,
      estimated_rent,
      sale_method: sale.method,
      rent_method: rent.method,
      sale_mean_ppsf: sale.mean_per_sqft,
      rent_mean_ppsf: rent.mean_per_sqft,
      comps_analyzed: compsAnalyzed,
    },
    duration_ms: Date.now() - start,
  });
}
