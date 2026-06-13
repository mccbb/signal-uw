// Claude API wrapper for step 7 (AI comp refinement). Mocked by default
// (MOCK_EXTERNAL != "false"); flip MOCK_EXTERNAL=false + set ANTHROPIC_API_KEY
// to go live. Model and max_tokens are fixed by the spec.
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const REFINE_MODEL = "claude-sonnet-4-20250514";
export const REFINE_MAX_TOKENS = 1000;
// Temperature 0 → the model takes its single most-likely path every time, so the
// same comps produce the same qualitative weights run-to-run (near-deterministic).
export const REFINE_TEMPERATURE = 0;

// Spec §5 step 7 — DO NOT MODIFY THIS SYSTEM PROMPT. Transcribed verbatim.
export const REFINE_SYSTEM_PROMPT =
  `You are a professional real estate underwriter and comp analyst with deep knowledge of residential real estate valuation. You will be given a subject property and its top 10 most similar comps, pre-scored by a mathematical similarity model. Your job is to identify which comps are truly comparable and which should be downweighted or excluded based on qualitative factors the math cannot see.

Evaluate each comp for the following red flags:
- Is the comp on a high-traffic arterial road, corner lot at a subdivision entrance, or otherwise exposed to commercial activity, gas stations, industrial, or heavy traffic?
- Does the comp back to commercial property, a highway, a major road, or other negative exposure?
- Is the comp in a visibly different neighborhood, subdivision, or quality tier even if the specs are similar on paper?
- Are the lots, yards, or overall feel significantly different from the subject despite similar square footage and year built?
- Is the comp on the same street or within the same subdivision as the subject? If so, weight it higher.
- Is the comp in a clearly inferior or superior location within the same zip code?

For each comp return a qualitative weight between 0.5 and 1.5 where:
1.5 = excellent comp, same street or subdivision, no red flags
1.0 = good comp, no notable issues
0.75 = fair comp, minor concerns
0.5 = poor comp, significant qualitative issues

Multiply each comp's mathematical similarity score by your qualitative weight to produce a final weighted score. Return the top 7 comps by final weighted score. Then remove the highest and lowest priced comps from those 7, leaving exactly 5.

Return JSON only. No preamble. No markdown. This exact format:
{
  "comps": [
    {
      "address": string,
      "similarity_score": float,
      "ai_weight": float,
      "final_score": float,
      "ai_notes": string,
      "price_per_sqft": float
    }
  ],
  "excluded_high": { "address": string, "reason": string },
  "excluded_low": { "address": string, "reason": string }
}`;

export interface CompForAI {
  address: string;
  similarity_score: number;
  price: number | null;
  squareFootage: number | null;
  bedrooms?: number;
  bathrooms?: number;
  yearBuilt?: number;
  lotSize?: number;
  distance?: number | null;
}

export interface RefinedComp {
  address: string;
  similarity_score: number;
  ai_weight: number;
  final_score: number;
  ai_notes: string;
  price_per_sqft: number | null;
}

export interface RefineResult {
  comps: RefinedComp[];
  excluded_high: { address: string; reason: string } | null;
  excluded_low: { address: string; reason: string } | null;
}

export interface RefinePayload {
  subject: Record<string, unknown>;
  avm_type: "rent" | "sale";
  comps: CompForAI[];
}

export async function refineComps(payload: RefinePayload): Promise<RefineResult> {
  const useMock = Deno.env.get("MOCK_EXTERNAL") !== "false";
  return useMock ? mockRefine(payload) : await liveRefine(payload);
}

const ppsf = (c: CompForAI): number | null =>
  (typeof c.price === "number" && typeof c.squareFootage === "number" && c.squareFootage > 0)
    ? Number((c.price / c.squareFootage).toFixed(2))
    : null;

// ---- Mock ---------------------------------------------------------------
// Deterministic stand-in for the model: assigns a qualitative weight, computes
// final_score = similarity * weight, takes the top 7, then removes the highest-
// and lowest-priced of those 7 to leave 5. With fewer than 3 comps it keeps all.
function mockRefine(payload: RefinePayload): RefineResult {
  const weighted = payload.comps.map((c) => {
    const w = [0.5, 0.75, 1.0, 1.25, 1.5][fnv1a(c.address) % 5];
    return {
      address: c.address,
      similarity_score: Number(c.similarity_score.toFixed(4)),
      ai_weight: w,
      final_score: Number((c.similarity_score * w).toFixed(4)),
      ai_notes: `Mock qualitative weight ${w} applied (no live model).`,
      price_per_sqft: ppsf(c),
      _price: c.price ?? 0,
    };
  });

  weighted.sort((a, b) => b.final_score - a.final_score);
  const top7 = weighted.slice(0, 7);

  let excluded_high: RefineResult["excluded_high"] = null;
  let excluded_low: RefineResult["excluded_low"] = null;
  let finals = top7;

  if (top7.length >= 3) {
    const byPrice = [...top7].sort((a, b) => a._price - b._price);
    const low = byPrice[0];
    const high = byPrice[byPrice.length - 1];
    excluded_low = { address: low.address, reason: "Lowest priced of the top 7 (trimmed per method)." };
    excluded_high = { address: high.address, reason: "Highest priced of the top 7 (trimmed per method)." };
    finals = top7.filter((c) => c.address !== low.address && c.address !== high.address);
  }

  return {
    comps: finals.map(({ _price: _omit, ...c }) => c),
    excluded_high,
    excluded_low,
  };
}

// ---- Live ---------------------------------------------------------------
async function liveRefine(payload: RefinePayload): Promise<RefineResult> {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("ANTHROPIC_API_KEY not set while MOCK_EXTERNAL=false");

  const userMessage = JSON.stringify({
    subject: payload.subject,
    avm_type: payload.avm_type,
    comps: payload.comps,
  });

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: REFINE_MODEL,
      max_tokens: REFINE_MAX_TOKENS,
      temperature: REFINE_TEMPERATURE,
      system: REFINE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (res.status === 401) throw new Error("Anthropic auth error (401): invalid API key");
  if (!res.ok) throw new Error(`Anthropic API error: HTTP ${res.status}`);

  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  return parseRefineJson(text);
}

// Robust parse: strip markdown fences / preamble and JSON.parse.
function parseRefineJson(text: string): RefineResult {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) t = t.slice(firstBrace, lastBrace + 1);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(t);
  } catch (_e) {
    throw new Error("Could not parse model JSON response");
  }
  return {
    comps: Array.isArray(parsed.comps) ? parsed.comps as RefinedComp[] : [],
    excluded_high: (parsed.excluded_high as RefineResult["excluded_high"]) ?? null,
    excluded_low: (parsed.excluded_low as RefineResult["excluded_low"]) ?? null,
  };
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
