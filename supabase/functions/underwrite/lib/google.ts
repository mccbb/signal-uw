// Google Geocoding wrapper for step 2. Mocked by default (MOCK_EXTERNAL !=
// "false") so the engine runs with no keys; flip MOCK_EXTERNAL=false and set
// GOOGLE_GEOCODING_API_KEY to go live. Returns null when an address can't be
// resolved (the step turns that into the spec's user-facing error).
export interface GeocodeResult {
  formatted_address: string;
  lat: number;
  lng: number;
  street: string;
  city: string;
  state: string;
  zip: string;
}

export async function geocode(rawAddress: string): Promise<GeocodeResult | null> {
  const useMock = Deno.env.get("MOCK_EXTERNAL") !== "false";
  return useMock ? mockGeocode(rawAddress) : await liveGeocode(rawAddress);
}

// Deterministic fake geocode: same input → same coords, so tests are stable.
// Treats clearly-bad input as "no results" to exercise the failure path.
function mockGeocode(raw: string): GeocodeResult | null {
  const s = raw.trim();
  if (!s || s.length < 5 || /(^|\s)(invalid|zzz+|asdf|test-fail)(\s|$)/i.test(s)) return null;

  const h = fnv1a(s.toLowerCase());
  const lat = 33 + (h % 1000) / 1000;
  const lng = -(86 + ((h >> 3) % 1000) / 1000);
  const zip = String(35000 + (h % 1000)).padStart(5, "0");

  const parts = s.split(",").map((p) => p.trim()).filter(Boolean);
  const street = parts[0] ?? s;
  const city = parts[1] ?? "Birmingham";
  const stateGuess = (parts[2] ?? "AL").split(/\s+/)[0] ?? "AL";
  const state = stateGuess.toUpperCase().slice(0, 2);
  const formatted = `${street}, ${city}, ${state} ${zip}, USA`;
  return { formatted_address: formatted, lat, lng, street, city, state, zip };
}

async function liveGeocode(raw: string): Promise<GeocodeResult | null> {
  const key = Deno.env.get("GOOGLE_GEOCODING_API_KEY");
  if (!key) throw new Error("GOOGLE_GEOCODING_API_KEY not set while MOCK_EXTERNAL=false");

  const u = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  u.searchParams.set("address", raw);
  u.searchParams.set("key", key);

  const res = await fetch(u);
  const data = await res.json();
  // Surface the real Google status FIRST so config errors (REQUEST_DENIED,
  // OVER_QUERY_LIMIT, missing billing, key restrictions) aren't masked as
  // "no results". Only a true OK-with-no-results / ZERO_RESULTS returns null.
  if (data.status !== "OK") {
    if (data.status === "ZERO_RESULTS") return null;
    throw new Error(
      `Google geocoding error: ${data.status}${data.error_message ? " - " + data.error_message : ""}`,
    );
  }
  if (!data.results?.length) return null;

  const r = data.results[0];
  // deno-lint-ignore no-explicit-any
  const comp = (type: string, short = false) =>
    (r.address_components as any[]).find((c) => c.types.includes(type))?.[
      short ? "short_name" : "long_name"
    ] ?? "";

  const street = `${comp("street_number")} ${comp("route")}`.trim();
  return {
    formatted_address: r.formatted_address,
    lat: r.geometry.location.lat,
    lng: r.geometry.location.lng,
    street,
    city: comp("locality") || comp("sublocality") || comp("administrative_area_level_2"),
    state: comp("administrative_area_level_1", true),
    zip: comp("postal_code"),
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
