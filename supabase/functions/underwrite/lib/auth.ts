// Identity resolution for every surface, in priority order:
//   1. Signal API key  (x-signal-api-key)      → MCP / programmatic callers
//   2. Supabase session (Authorization: Bearer) → logged-in website users
//   3. neither                                   → anonymous (email free trial)
// API keys are stored only as a SHA-256 hash; session tokens are validated by
// Supabase Auth (auth.getUser).
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface AuthResult {
  userId: string | null;
  invalid: boolean; // a Signal API key was supplied but didn't match a live key
}

export async function resolveIdentity(
  db: SupabaseClient,
  opts: { apiKey?: string | null; bearer?: string | null },
): Promise<AuthResult> {
  // 1) Signal API key
  const key = (opts.apiKey ?? "").trim();
  if (key) {
    const hash = await sha256Hex(key);
    const { data, error } = await db
      .from("api_keys")
      .select("id, user_id")
      .eq("key_hash", hash)
      .eq("revoked", false)
      .maybeSingle();
    if (error) throw new Error(`resolveIdentity(apiKey) failed: ${error.message}`);
    if (!data) return { userId: null, invalid: true };
    db.from("api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id)
      .then(() => {}, () => {});
    return { userId: data.user_id as string, invalid: false };
  }

  // 2) Supabase session token (logged-in website user). Ignore the anon key,
  //    which the gateway also carries as a bearer for anonymous calls.
  const bearer = (opts.bearer ?? "").trim();
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (bearer && bearer !== anon) {
    const { data, error } = await db.auth.getUser(bearer);
    if (!error && data?.user?.id) return { userId: data.user.id, invalid: false };
  }

  // 3) anonymous
  return { userId: null, invalid: false };
}

export function normalizeAddressKey(raw: string): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isValidEmail(email: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
