// Step 6 — Similarity scoring (spec §6). Runs separately for the sale pool and
// the rent pool. For each comp: apply hard cutoffs, compute the weighted
// similarity, and store every comp in comp_scores (excluded comps get
// similarity 0, with reasons recorded in comp_json). Sort by similarity desc and
// pass the top 10 per pool to step 7 (next phase). garage_score/pool_score are
// stored null — dropped per the owner-approved weight renormalization.
import { getAvmComps, insertCompScores, logStep } from "../lib/db.ts";
import { scoreComp, type SubjectForScoring } from "../lib/scoring.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const TOP_N = 10;

export interface TopComp {
  comp_address: string;
  similarity_score: number;
}

export async function step6ScoreComps(
  db: SupabaseClient,
  jobId: string,
  subject: SubjectForScoring,
): Promise<{ sale: TopComp[]; rent: TopComp[] }> {
  const sale = await scorePool(db, jobId, "sale", subject);
  const rent = await scorePool(db, jobId, "rent", subject);
  return { sale, rent };
}

async function scorePool(
  db: SupabaseClient,
  jobId: string,
  avmType: "sale" | "rent",
  subject: SubjectForScoring,
): Promise<TopComp[]> {
  const start = Date.now();
  const base = { job_id: jobId, step: 6, function_name: "scoreComps" } as const;

  const comps = await getAvmComps(db, jobId, avmType);

  const rows: Record<string, unknown>[] = [];
  const scored: TopComp[] = [];
  let excludedCount = 0;

  for (const comp of comps) {
    const outcome = scoreComp(subject, comp);
    const compAddress = (comp.formattedAddress as string) ?? null;

    rows.push({
      job_id: jobId,
      avm_type: avmType,
      comp_address: compAddress,
      comp_json: {
        ...comp,
        _excluded: outcome.excluded,
        _exclusion_reasons: outcome.reasons,
        _distance_miles: outcome.distance_miles,
      },
      sqft_score: outcome.sub.sqft,
      distance_score: outcome.sub.distance,
      yearbuilt_score: outcome.sub.yearbuilt,
      lotsize_score: outcome.sub.lotsize,
      garage_score: null, // dropped (no comp data) — see scoring.ts header
      pool_score: null, // dropped (no comp data) — see scoring.ts header
      bedbath_score: outcome.sub.bedbath,
      similarity_score: outcome.similarity,
    });

    if (outcome.excluded) excludedCount++;
    else scored.push({ comp_address: compAddress ?? "(unknown)", similarity_score: outcome.similarity });
  }

  await insertCompScores(db, rows);

  scored.sort((a, b) => b.similarity_score - a.similarity_score);
  const top10 = scored.slice(0, TOP_N);

  await logStep(db, {
    ...base,
    status: "pass",
    input_payload: { avm_type: avmType },
    output_payload: {
      avm_type: avmType,
      total_comps: comps.length,
      excluded: excludedCount,
      scored: scored.length,
      passed_to_step7: top10.length,
      top10: top10.map((c) => ({ ...c, similarity_score: Number(c.similarity_score.toFixed(4)) })),
    },
    duration_ms: Date.now() - start,
  });

  return top10;
}
