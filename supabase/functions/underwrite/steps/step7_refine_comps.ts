// Step 7 — AI comp refinement (spec §5). Runs once per pool (sale, rent). Sends
// the subject + top comps to the model (mocked until live), which weights each
// comp, trims to the final 5, and names the excluded high/low. Stored in
// ai_comp_results.
//
// Sparse-pool policy (owner-approved, beyond the written spec): when a pool has
// fewer than TARGET surviving comps we (1) flag data_quality='low', (2) PULL BACK
// the comps that hard cutoffs removed — ranked by their underlying similarity —
// so the model still has a pool to work with, and (3) set use_avm_fallback so
// step 8 leads with the automated valuation estimate for that side. We never name
// the data source anywhere user-facing.
import {
  getAvmEstimate,
  getCompScores,
  insertAiCompResult,
  logStep,
} from "../lib/db.ts";
import { WEIGHTS } from "../lib/scoring.ts";
import { type CompForAI, type RefinedComp, refineComps } from "../lib/anthropic.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const TARGET_SURVIVORS = 7; // need >=7 to run the normal top-7 → drop-2 → 5 flow
const POOL_SIZE = 10; // comps sent to the model (spec: "top 10")

type Quality = "ok" | "low" | "none";

interface Excluded { address: string; reason: string }

// Deterministic final trim (spec §5: "top 7 by final score, remove highest and
// lowest priced, leaving exactly 5"). The model does the qualitative weighting;
// we enforce the mechanical trim so the output is always exactly 5 when the pool
// is large enough — immune to the model returning 6/7/etc. If the model returns
// <=5 (already trimmed, or a sparse pool), we keep its set as-is.
function enforceFinalFive(
  comps: RefinedComp[],
): { finals: RefinedComp[]; high: Excluded | null; low: Excluded | null } {
  if (comps.length <= 5) return { finals: comps, high: null, low: null };
  const byScore = [...comps].sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0));
  const top7 = byScore.slice(0, 7);
  const byPrice = [...top7].sort((a, b) => (a.price_per_sqft ?? 0) - (b.price_per_sqft ?? 0));
  const low = byPrice[0];
  const high = byPrice[byPrice.length - 1];
  const finals = top7.filter((c) => c !== low && c !== high);
  return {
    finals,
    high: { address: high.address, reason: `Removed in final trim — highest $/sqft (${high.price_per_sqft}) of the top ${top7.length}` },
    low: { address: low.address, reason: `Removed in final trim — lowest $/sqft (${low.price_per_sqft}) of the top ${top7.length}` },
  };
}

// Underlying similarity from the stored sub-score columns — equals the stored
// similarity_score for survivors, and reconstructs a rank for excluded comps
// (whose similarity_score was zeroed) so pull-back can order them.
function rawSimilarity(row: Record<string, unknown>): number {
  const n = (v: unknown) => (typeof v === "number" ? v : 0);
  return (
    n(row.sqft_score) * WEIGHTS.sqft +
    n(row.distance_score) * WEIGHTS.distance +
    n(row.yearbuilt_score) * WEIGHTS.yearbuilt +
    n(row.lotsize_score) * WEIGHTS.lotsize +
    n(row.bedbath_score) * WEIGHTS.bedbath
  );
}

function toCompForAI(row: Record<string, unknown>, sim: number): CompForAI {
  const cj = (row.comp_json ?? {}) as Record<string, unknown>;
  return {
    address: (row.comp_address as string) ?? "(unknown)",
    similarity_score: Number(sim.toFixed(4)),
    price: typeof cj.price === "number" ? cj.price : null,
    squareFootage: typeof cj.squareFootage === "number" ? cj.squareFootage : null,
    bedrooms: cj.bedrooms as number | undefined,
    bathrooms: cj.bathrooms as number | undefined,
    yearBuilt: cj.yearBuilt as number | undefined,
    lotSize: cj.lotSize as number | undefined,
    distance: (cj._distance_miles as number | null) ?? null,
  };
}

export async function step7RefineComps(
  db: SupabaseClient,
  jobId: string,
  subject: Record<string, unknown>,
): Promise<void> {
  await refinePool(db, jobId, "sale", subject);
  await refinePool(db, jobId, "rent", subject);
}

async function refinePool(
  db: SupabaseClient,
  jobId: string,
  avmType: "sale" | "rent",
  subject: Record<string, unknown>,
): Promise<void> {
  const start = Date.now();
  const base = { job_id: jobId, step: 7, function_name: "refineComps" } as const;

  const rows = await getCompScores(db, jobId, avmType);
  const isExcluded = (r: Record<string, unknown>) =>
    ((r.comp_json as Record<string, unknown>)?._excluded as boolean) === true;
  const survivors = rows.filter((r) => !isExcluded(r));

  const avm = await getAvmEstimate(db, jobId, avmType);

  // No comps at all → skip the model call (no cost); step 8 will use the AVM.
  if (rows.length === 0) {
    const quality: Quality = "none";
    const meta = {
      survivors: 0,
      total: 0,
      pulled_back: [],
      use_avm_fallback: true,
      avm_estimate: avm?.estimate ?? null,
      note: "No comparable data available; leading with the automated valuation estimate.",
    };
    await insertAiCompResult(db, jobId, {
      avm_type: avmType,
      final_comps_json: [],
      excluded_high_json: null,
      excluded_low_json: null,
      data_quality: quality,
      quality_meta: meta,
    });
    await logStep(db, {
      ...base,
      status: "pass",
      input_payload: { avm_type: avmType },
      output_payload: { avm_type: avmType, data_quality: quality, final_count: 0, ...meta },
      duration_ms: Date.now() - start,
    });
    return;
  }

  // Choose the comp pool sent to the model.
  let quality: Quality;
  let pool: Record<string, unknown>[];
  let pulledBack: { address: string; reasons: unknown }[] = [];

  if (survivors.length >= TARGET_SURVIVORS) {
    quality = "ok";
    pool = [...survivors]
      .sort((a, b) => rawSimilarity(b) - rawSimilarity(a))
      .slice(0, POOL_SIZE);
  } else {
    // Sparse: pull back excluded comps and rank the best-available by raw similarity.
    quality = "low";
    pool = [...rows]
      .sort((a, b) => rawSimilarity(b) - rawSimilarity(a))
      .slice(0, POOL_SIZE);
    pulledBack = pool
      .filter(isExcluded)
      .map((r) => ({
        address: (r.comp_address as string) ?? "(unknown)",
        reasons: (r.comp_json as Record<string, unknown>)?._exclusion_reasons ?? [],
      }));
  }

  const compsForAI = pool.map((r) => toCompForAI(r, rawSimilarity(r)));

  const ai = await refineComps({ subject, avm_type: avmType, comps: compsForAI });

  // Deterministically enforce the spec's final trim to exactly 5 (the model
  // sometimes returns 6/7). Our enforced high/low take precedence; fall back to
  // the model's named ones when no trim was needed (<=5 comps returned).
  const trim = enforceFinalFive(ai.comps);
  const finalComps = trim.finals;
  const excludedHigh = trim.high ?? ai.excluded_high;
  const excludedLow = trim.low ?? ai.excluded_low;

  const useAvmFallback = quality !== "ok";
  const meta = {
    survivors: survivors.length,
    total: rows.length,
    pulled_back: pulledBack,
    use_avm_fallback: useAvmFallback,
    avm_estimate: avm?.estimate ?? null,
    ai_returned_count: ai.comps.length, // before our trim
    final_count: finalComps.length, // after enforcement
    note: useAvmFallback
      ? "Comparable data was thin for this property; the best-available comps are shown and the headline value leads with the automated valuation estimate."
      : "Sufficient comparable data; value is comp-derived.",
  };

  await insertAiCompResult(db, jobId, {
    avm_type: avmType,
    final_comps_json: finalComps,
    excluded_high_json: excludedHigh,
    excluded_low_json: excludedLow,
    data_quality: quality,
    quality_meta: meta,
  });

  await logStep(db, {
    ...base,
    status: "pass",
    input_payload: { avm_type: avmType, pool_size: compsForAI.length },
    output_payload: {
      avm_type: avmType,
      data_quality: quality,
      ai_returned_count: ai.comps.length,
      final_count: finalComps.length,
      final_comps: finalComps.map((c) => ({ address: c.address, final_score: c.final_score })),
      excluded_high: excludedHigh?.address ?? null,
      excluded_low: excludedLow?.address ?? null,
      pulled_back: pulledBack.length,
      use_avm_fallback: useAvmFallback,
    },
    duration_ms: Date.now() - start,
  });
}
