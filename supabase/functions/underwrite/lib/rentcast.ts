// RentCast wrapper for step 3 (Property Records, GET /properties) — and the base
// for step 4's AVM calls later. Mocked by default (MOCK_EXTERNAL != "false");
// flip MOCK_EXTERNAL=false + set RENTCAST_API_KEY to go live.
//
// The real /properties endpoint returns an ARRAY of records. For a specific
// address we use the first element. Both mock and live return that same shape so
// the step's mapping code is identical in either mode.
const RENTCAST_BASE = "https://api.rentcast.io/v1";

// Loose typing: we only read a handful of fields and keep the whole object in
// subject_properties.raw_json, so we don't over-constrain the schema here.
export type RentcastRecord = Record<string, unknown> & {
  formattedAddress?: string;
  latitude?: number;
  longitude?: number;
  propertyType?: string;
  bedrooms?: number;
  bathrooms?: number;
  squareFootage?: number;
  lotSize?: number; // square feet
  yearBuilt?: number;
  features?: {
    garage?: boolean;
    garageSpaces?: number;
    pool?: boolean;
    [k: string]: unknown;
  };
};

export async function getPropertyRecord(
  rentcastAddress: string,
): Promise<RentcastRecord | null> {
  const useMock = Deno.env.get("MOCK_EXTERNAL") !== "false";
  const records = useMock
    ? mockProperties(rentcastAddress)
    : await liveProperties(rentcastAddress);
  return records.length ? records[0] : null;
}

// ---- Mock ---------------------------------------------------------------
// Deterministic record built from the address so tests are stable. Mirrors the
// real RentCast field shape. Address containing "norecord" returns [] to
// exercise the not-found path.
function mockProperties(addr: string): RentcastRecord[] {
  if (/norecord/i.test(addr)) return [];

  const h = fnv1a(addr.toLowerCase());
  const sqft = 1200 + (h % 2600); // 1200–3800
  const beds = 2 + (h % 4); // 2–5
  const baths = 1 + ((h >> 2) % 4) * 0.5 + 1; // 2–3.5
  const yearBuilt = 1950 + (h % 73); // 1950–2022
  const lotSqft = 5000 + ((h >> 3) % 38000); // ~0.11–0.99 ac mostly
  const garageSpaces = (h >> 4) % 4; // 0–3
  const hasPool = ((h >> 6) % 5) === 0; // ~20%
  const types = ["Single Family", "Townhouse", "Condo", "Multi-Family"];
  const propertyType = types[(h >> 7) % types.length];

  const lat = 33 + (h % 1000) / 1000;
  const lng = -(86 + ((h >> 3) % 1000) / 1000);
  const lastSalePrice = Math.round((sqft * (110 + (h % 90))) / 1000) * 1000;

  const record: RentcastRecord = {
    id: addr.replace(/[ ,]+/g, "-"),
    formattedAddress: addr,
    propertyType,
    bedrooms: beds,
    bathrooms: baths,
    squareFootage: sqft,
    lotSize: lotSqft,
    yearBuilt,
    latitude: lat,
    longitude: lng,
    lastSalePrice,
    features: {
      garage: garageSpaces > 0,
      garageSpaces,
      pool: hasPool,
      floorCount: 1 + (h % 2),
    },
    _mock: true,
  };
  return [record];
}

// ---- Live ---------------------------------------------------------------
async function liveProperties(addr: string): Promise<RentcastRecord[]> {
  const key = Deno.env.get("RENTCAST_API_KEY");
  if (!key) throw new Error("RENTCAST_API_KEY not set while MOCK_EXTERNAL=false");

  const u = new URL(`${RENTCAST_BASE}/properties`);
  u.searchParams.set("address", addr);

  const res = await fetch(u, { headers: { "X-Api-Key": key, accept: "application/json" } });
  if (res.status === 401) throw new Error("RentCast auth error (401): invalid API key");
  if (!res.ok) throw new Error(`RentCast /properties error: HTTP ${res.status}`);

  const data = await res.json();
  // The endpoint returns an array; a single-address lookup may also 404→handled above.
  return Array.isArray(data) ? data as RentcastRecord[] : [data as RentcastRecord];
}

// =========================================================================
// Step 4 — AVM pulls (Rent Estimate + Value Estimate)
// =========================================================================
// compCount max allowable per RentCast docs is 25 (spec: "maximum allowable").
// Comp count / radius do NOT affect cost — it's one API call per AVM.
export const MAX_COMP_COUNT = 25;
// RentCast documents a 100-mile max radius on /properties; reuse as the widest
// allowable here. Step 6 hard-cuts comps beyond 1 mile anyway.
export const MAX_RADIUS_MILES = 100;

export type AvmType = "rent" | "sale";

export interface AvmAttrs {
  propertyType?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
  latitude?: number | null;
  longitude?: number | null;
}

export interface AvmResult {
  avm_type: AvmType;
  estimate: number | null;
  range_low: number | null;
  range_high: number | null;
  comps: Record<string, unknown>[]; // full RentCast comparables array
  raw: Record<string, unknown>;
}

export async function getAVM(
  type: AvmType,
  rentcastAddress: string,
  attrs: AvmAttrs,
): Promise<AvmResult> {
  const useMock = Deno.env.get("MOCK_EXTERNAL") !== "false";
  return useMock ? mockAvm(type, rentcastAddress, attrs) : await liveAvm(type, rentcastAddress, attrs);
}

// ---- Mock ---------------------------------------------------------------
// Deterministic estimate + comp pool mirroring the real AVM comparable schema
// (note: real AVM comps do NOT include garage/pool — neither does this mock).
function mockAvm(type: AvmType, addr: string, attrs: AvmAttrs): AvmResult {
  const h = fnv1a(`${type}:${addr.toLowerCase()}`);
  const subjSqft = typeof attrs.squareFootage === "number" && attrs.squareFootage > 0
    ? attrs.squareFootage
    : 1800;

  // $/sqft (sale) or $/sqft-monthly (rent)
  const perSqft = type === "sale" ? 95 + (h % 130) : 0.7 + (h % 80) / 100; // sale 95–225, rent 0.70–1.50
  const estimate = type === "sale"
    ? Math.round((subjSqft * perSqft) / 1000) * 1000
    : Math.round((subjSqft * perSqft) / 5) * 5;
  const spread = type === "sale" ? 0.12 : 0.08;
  const range_low = Math.round(estimate * (1 - spread));
  const range_high = Math.round(estimate * (1 + spread));

  const baseLat = typeof attrs.latitude === "number" ? attrs.latitude : 33.5;
  const baseLng = typeof attrs.longitude === "number" ? attrs.longitude : -86.8;
  const beds = typeof attrs.bedrooms === "number" ? attrs.bedrooms : 3;
  const baths = typeof attrs.bathrooms === "number" ? attrs.bathrooms : 2;
  const ptype = attrs.propertyType ?? "Single Family";

  // 18 comps spread out in size/distance/age so step 6 has a real pool to score.
  const comps: Record<string, unknown>[] = [];
  for (let i = 0; i < 18; i++) {
    const g = fnv1a(`${addr}:${type}:${i}`);
    const sqft = Math.max(600, subjSqft + ((g % 1000) - 500)); // ±500
    const distance = Number((((g >> 2) % 200) / 100).toFixed(4)); // 0–2.0 mi
    const yearBuilt = 1950 + (g % 73);
    const lotSize = 4000 + ((g >> 3) % 40000);
    const compPerSqft = perSqft * (0.85 + ((g % 30) / 100)); // ±~15%
    const price = type === "sale"
      ? Math.round((sqft * compPerSqft) / 500) * 500
      : Math.round((sqft * compPerSqft) / 5) * 5;
    // crude lat/lng offset roughly matching `distance`
    const dLat = distance / 69;
    comps.push({
      id: `${addr.replace(/[ ,]+/g, "-")}-comp-${i}`,
      formattedAddress: `${100 + i} Mock Comp Dr, ${addr.split(",")[1]?.trim() ?? "Birmingham"}`,
      propertyType: ptype,
      bedrooms: beds + ((g >> 5) % 3) - 1,
      bathrooms: baths + (((g >> 6) % 3) - 1) * 0.5,
      squareFootage: sqft,
      lotSize,
      yearBuilt,
      latitude: Number((baseLat + dLat).toFixed(6)),
      longitude: Number((baseLng + dLat).toFixed(6)),
      price,
      status: (g % 2) === 0 ? "Active" : "Inactive",
      distance,
      daysOld: g % 365,
      correlation: Number((0.9 + (g % 10) / 100).toFixed(4)),
      _mock: true,
    });
  }

  const subjectProperty = {
    formattedAddress: addr,
    propertyType: ptype,
    bedrooms: beds,
    bathrooms: baths,
    squareFootage: subjSqft,
    latitude: baseLat,
    longitude: baseLng,
  };

  const raw = type === "sale"
    ? { price: estimate, priceRangeLow: range_low, priceRangeHigh: range_high, subjectProperty, comparables: comps, _mock: true }
    : { rent: estimate, rentRangeLow: range_low, rentRangeHigh: range_high, subjectProperty, comparables: comps, _mock: true };

  return { avm_type: type, estimate, range_low, range_high, comps, raw };
}

// ---- Live ---------------------------------------------------------------
async function liveAvm(type: AvmType, addr: string, attrs: AvmAttrs): Promise<AvmResult> {
  const key = Deno.env.get("RENTCAST_API_KEY");
  if (!key) throw new Error("RENTCAST_API_KEY not set while MOCK_EXTERNAL=false");

  const path = type === "rent" ? "/avm/rent/long-term" : "/avm/value";
  const u = new URL(`${RENTCAST_BASE}${path}`);
  u.searchParams.set("address", addr);
  u.searchParams.set("compCount", String(MAX_COMP_COUNT));
  u.searchParams.set("maxRadius", String(MAX_RADIUS_MILES));
  if (attrs.propertyType) u.searchParams.set("propertyType", attrs.propertyType);
  if (typeof attrs.bedrooms === "number") u.searchParams.set("bedrooms", String(attrs.bedrooms));
  if (typeof attrs.bathrooms === "number") u.searchParams.set("bathrooms", String(attrs.bathrooms));
  if (typeof attrs.squareFootage === "number") u.searchParams.set("squareFootage", String(attrs.squareFootage));

  const res = await fetch(u, { headers: { "X-Api-Key": key, accept: "application/json" } });
  if (res.status === 401) throw new Error("RentCast auth error (401): invalid API key");
  if (!res.ok) throw new Error(`RentCast ${path} error: HTTP ${res.status}`);

  const data = await res.json() as Record<string, unknown>;
  const comps = Array.isArray(data.comparables) ? data.comparables as Record<string, unknown>[] : [];
  const estimate = (type === "rent" ? data.rent : data.price) as number ?? null;
  const range_low = (type === "rent" ? data.rentRangeLow : data.priceRangeLow) as number ?? null;
  const range_high = (type === "rent" ? data.rentRangeHigh : data.priceRangeHigh) as number ?? null;

  return { avm_type: type, estimate, range_low, range_high, comps, raw: data };
}

function fnv1a(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}
