// Step 6 similarity scoring — the critical math, isolated and pure (spec §6).
// Formulas are transcribed verbatim from the spec. The ONLY deviation is the
// weights: RentCast AVM comps carry no garage/pool data, so the garage (0.05)
// and pool (0.03) sub-scores are DROPPED and the remaining five weights are
// renormalized to sum to 1.0. Approved by product owner (Mac) 2026-06-10.

export interface SubjectForScoring {
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  year_built: number | null;
  lot_size_acres: number | null;
  lat: number | null;
  lng: number | null;
}

export interface CompForScoring {
  squareFootage?: number;
  bedrooms?: number;
  bathrooms?: number;
  yearBuilt?: number;
  lotSize?: number; // square feet
  latitude?: number;
  longitude?: number;
  distance?: number; // miles, when RentCast provides it
  [k: string]: unknown;
}

const SQFT_PER_ACRE = 43560;

// ---- Weights (renormalized; see header note) ----------------------------
const ACTIVE_RAW: Record<string, number> = {
  sqft: 0.30,
  distance: 0.25,
  yearbuilt: 0.20,
  lotsize: 0.15,
  bedbath: 0.02,
};
const RAW_SUM = Object.values(ACTIVE_RAW).reduce((a, b) => a + b, 0); // 0.92
export const WEIGHTS: Record<keyof typeof ACTIVE_RAW | string, number> = Object.fromEntries(
  Object.entries(ACTIVE_RAW).map(([k, v]) => [k, v / RAW_SUM]),
);

// ---- Hard-cutoff thresholds (spec, unchanged) ---------------------------
const CUTOFF_SQFT = 500;
const CUTOFF_DISTANCE_MI = 1;
const CUTOFF_YEAR = 20;
const LOT_TIER_ACRES = 1;

export interface SubScores {
  sqft: number | null;
  distance: number | null;
  yearbuilt: number | null;
  lotsize: number | null;
  bedbath: number | null;
}

export interface ScoreOutcome {
  excluded: boolean;
  reasons: string[];
  distance_miles: number | null;
  sub: SubScores;
  similarity: number;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function haversineMiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 3958.8; // miles
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Prefer RentCast's own distance; otherwise compute from coordinates.
export function distanceMiles(subject: SubjectForScoring, comp: CompForScoring): number | null {
  if (typeof comp.distance === "number") return comp.distance;
  if (
    typeof comp.latitude === "number" && typeof comp.longitude === "number" &&
    typeof subject.lat === "number" && typeof subject.lng === "number"
  ) {
    return haversineMiles(subject.lat, subject.lng, comp.latitude, comp.longitude);
  }
  return null;
}

// Returns acres for a comp's lotSize (RentCast reports square feet).
function compLotAcres(comp: CompForScoring): number | null {
  return typeof comp.lotSize === "number" ? comp.lotSize / SQFT_PER_ACRE : null;
}

// Hard cutoffs — any hit means score 0 and full exclusion. A cutoff is only
// applied when both values needed for it are present.
export function hardCutoffs(
  subject: SubjectForScoring,
  comp: CompForScoring,
  dist: number | null,
): { excluded: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (typeof subject.sqft === "number" && typeof comp.squareFootage === "number") {
    if (Math.abs(comp.squareFootage - subject.sqft) > CUTOFF_SQFT) reasons.push("sqft_diff_gt_500");
  }
  if (typeof dist === "number" && dist > CUTOFF_DISTANCE_MI) reasons.push("distance_gt_1mi");
  if (typeof subject.year_built === "number" && typeof comp.yearBuilt === "number") {
    if (Math.abs(comp.yearBuilt - subject.year_built) > CUTOFF_YEAR) reasons.push("yearbuilt_diff_gt_20");
  }
  const cl = compLotAcres(comp);
  if (typeof subject.lot_size_acres === "number" && typeof cl === "number") {
    const subUnder = subject.lot_size_acres < LOT_TIER_ACRES;
    const compUnder = cl < LOT_TIER_ACRES;
    if (subUnder !== compUnder) reasons.push("lot_tier_mismatch");
  }
  return { excluded: reasons.length > 0, reasons };
}

// The five sub-scores. Missing inputs yield a neutral 0.5 for that dimension so
// one absent field doesn't unfairly sink an otherwise-good comp.
export function subScores(
  subject: SubjectForScoring,
  comp: CompForScoring,
  dist: number | null,
): SubScores {
  // Square footage (30%)
  const sqft = (typeof subject.sqft === "number" && typeof comp.squareFootage === "number")
    ? clamp01(1 - Math.abs(comp.squareFootage - subject.sqft) / 500)
    : 0.5;

  // Distance (25%)
  const distance = typeof dist === "number" ? clamp01(1 - dist / 1.0) : 0.5;

  // Year built (20%)
  const yearbuilt = (typeof subject.year_built === "number" && typeof comp.yearBuilt === "number")
    ? clamp01(1 - Math.abs(comp.yearBuilt - subject.year_built) / 20)
    : 0.5;

  // Lot size (15%) — both same tier to reach here; neutral if data/zero missing
  const cl = compLotAcres(comp);
  let lotsize: number;
  if (typeof subject.lot_size_acres === "number" && subject.lot_size_acres > 0 && typeof cl === "number") {
    lotsize = clamp01(1 - Math.abs(cl - subject.lot_size_acres) / (subject.lot_size_acres * 2));
  } else {
    lotsize = 0.5;
  }

  // Beds/baths (2%) — exact=1.0, off by 1=0.7, off by 2+=0.4
  let bedbath: number;
  if (typeof subject.beds === "number" && typeof subject.baths === "number" &&
      typeof comp.bedrooms === "number" && typeof comp.bathrooms === "number") {
    const delta = Math.abs(comp.bedrooms - subject.beds) + Math.abs(comp.bathrooms - subject.baths);
    bedbath = delta === 0 ? 1.0 : delta < 2 ? 0.7 : 0.4;
  } else {
    bedbath = 0.5;
  }

  return { sqft, distance, yearbuilt, lotsize, bedbath };
}

// Final weighted similarity over the five active sub-scores.
export function similarity(sub: SubScores): number {
  return (
    (sub.sqft ?? 0) * WEIGHTS.sqft +
    (sub.distance ?? 0) * WEIGHTS.distance +
    (sub.yearbuilt ?? 0) * WEIGHTS.yearbuilt +
    (sub.lotsize ?? 0) * WEIGHTS.lotsize +
    (sub.bedbath ?? 0) * WEIGHTS.bedbath
  );
}

// Full per-comp scoring outcome.
export function scoreComp(subject: SubjectForScoring, comp: CompForScoring): ScoreOutcome {
  const dist = distanceMiles(subject, comp);
  const { excluded, reasons } = hardCutoffs(subject, comp, dist);
  const sub = subScores(subject, comp, dist);
  const sim = excluded ? 0 : similarity(sub);
  return { excluded, reasons, distance_miles: dist, sub, similarity: sim };
}
