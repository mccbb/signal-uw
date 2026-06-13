// Step 3 — RentCast property data (spec §5). Calls GET /properties (mocked until
// live), maps the record onto subject_properties, and stores the full response in
// raw_json. Required fields that come back null are logged as a warning but do
// NOT halt the job (spec: "log warning but continue"). No record at all is a
// step-3 failure.
import { insertSubjectProperty, logStep } from "../lib/db.ts";
import { StepError } from "../lib/errors.ts";
import { getPropertyRecord, type RentcastRecord } from "../lib/rentcast.ts";
import type { GeocodeResult } from "../lib/google.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const SQFT_PER_ACRE = 43560;
const REQUIRED_FIELDS = [
  "sqft",
  "beds",
  "baths",
  "year_built",
  "lot_size_acres",
  "garage",
  "pool",
  "property_type",
] as const;

interface SubjectProperty {
  address: string | null;
  lat: number | null;
  lng: number | null;
  sqft: number | null;
  beds: number | null;
  baths: number | null;
  year_built: number | null;
  lot_size_acres: number | null;
  garage: number | null; // number of doors
  pool: boolean | null;
  property_type: string | null;
  raw_json: RentcastRecord;
}

// Map a RentCast record onto our subject_properties shape. Geocode result from
// step 2 is the fallback for lat/lng/address.
function mapRecord(rec: RentcastRecord, geo: GeocodeResult): SubjectProperty {
  const f = rec.features ?? {};
  const garage = typeof f.garageSpaces === "number"
    ? f.garageSpaces
    : f.garage === true
    ? null // garage present but door count unknown
    : f.garage === false
    ? 0
    : null;

  return {
    address: rec.formattedAddress ?? geo.formatted_address ?? null,
    lat: typeof rec.latitude === "number" ? rec.latitude : geo.lat ?? null,
    lng: typeof rec.longitude === "number" ? rec.longitude : geo.lng ?? null,
    sqft: typeof rec.squareFootage === "number" ? rec.squareFootage : null,
    beds: typeof rec.bedrooms === "number" ? rec.bedrooms : null,
    baths: typeof rec.bathrooms === "number" ? rec.bathrooms : null,
    year_built: typeof rec.yearBuilt === "number" ? rec.yearBuilt : null,
    lot_size_acres: typeof rec.lotSize === "number" ? rec.lotSize / SQFT_PER_ACRE : null,
    garage,
    pool: typeof f.pool === "boolean" ? f.pool : null,
    property_type: typeof rec.propertyType === "string" ? rec.propertyType : null,
    raw_json: rec,
  };
}

export async function step3GetPropertyData(
  db: SupabaseClient,
  jobId: string,
  geo: GeocodeResult,
): Promise<{ subjectPropertyId: string; subject: SubjectProperty }> {
  const start = Date.now();
  const base = { job_id: jobId, step: 3, function_name: "getPropertyData" } as const;

  // RentCast prefers "Street, City, State, Zip" — build it from step-2 components.
  const rentcastAddress = `${geo.street}, ${geo.city}, ${geo.state}, ${geo.zip}`;

  let record: RentcastRecord | null;
  try {
    record = await getPropertyRecord(rentcastAddress);
  } catch (e) {
    const detail = String((e as Error)?.message ?? e);
    await logStep(db, {
      ...base,
      status: "fail",
      input_payload: { rentcastAddress },
      error_message: detail,
      duration_ms: Date.now() - start,
    });
    throw new StepError(3, "I couldn't pull property data for that address. Please try again.", detail);
  }

  if (!record) {
    await logStep(db, {
      ...base,
      status: "fail",
      input_payload: { rentcastAddress },
      error_message: "No property record found",
      duration_ms: Date.now() - start,
    });
    throw new StepError(
      3,
      "I couldn't find property records for that address.",
      "RentCast returned no records",
    );
  }

  const subject = mapRecord(record, geo);
  const { raw_json: _omit, ...flat } = subject;
  const missing = REQUIRED_FIELDS.filter((k) => flat[k] === null || flat[k] === undefined);

  const { id } = await insertSubjectProperty(db, jobId, subject as Record<string, unknown>);

  await logStep(db, {
    ...base,
    status: "pass",
    input_payload: { rentcastAddress },
    output_payload: {
      subject_property_id: id,
      mapped: flat,
      missing_required_fields: missing, // warning only — job continues
    },
    error_message: missing.length ? `Missing required fields: ${missing.join(", ")}` : undefined,
    duration_ms: Date.now() - start,
  });

  return { subjectPropertyId: id, subject };
}
