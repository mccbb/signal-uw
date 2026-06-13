# Wiring the homepage chat window to Signal (bolt.new site)

Your website chat does **not** use MCP. It calls the Signal `/underwrite` REST
endpoint directly: POST the address, poll the job, render the report. This is the
same engine the MCP and everything else uses (spec: "every surface calls the same
single API endpoint").

Give this snippet to Bolt (or paste into your project) and have the chat's
"send" handler call `runUnderwrite(address, onProgress)`.

```js
// --- Signal client (browser-safe; uses the publishable anon key) ---
const SIGNAL_URL = "https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/underwrite";
const SUPABASE_ANON_KEY = "<your publishable anon key>"; // safe in the browser

// Auth is Google-only and required. Pass the signed-in user's Supabase session
// token as the Bearer (from supabase-js):
//   const { data } = await supabase.auth.getSession();
//   const token = data.session?.access_token;
// There is no anonymous flow — if there's no token, prompt Google sign-in first.
async function runUnderwrite(address, { onProgress, sessionToken } = {}) {
  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
  };
  if (sessionToken) headers["Authorization"] = `Bearer ${sessionToken}`;

  // 1) Start the job (or get an instant cache hit for repeat addresses).
  const startRes = await fetch(SIGNAL_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ address }),
  });
  const started = await startRes.json();
  if (startRes.status === 401 && started.need_signin) {
    throw new Error("NEED_SIGNIN"); // show "Continue with Google"
  }
  if (startRes.status === 402 && started.trial_exhausted) {
    throw new Error("TRIAL_EXHAUSTED"); // 2 free used → show the paywall
  }
  if (startRes.status === 400) throw new Error(started.error || "Enter an address.");

  // Cache hit / already complete → done.
  if (started.status === "complete" || started.arv !== undefined) return started;

  // 2) Poll every 2s until complete or failed.
  const jobId = started.job_id;
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(`${SIGNAL_URL}?job_id=${jobId}`, { headers });
    const view = await pollRes.json();
    onProgress?.(view.current_step ?? 0); // 1..8, drive a progress indicator
    if (view.status === "complete") return view;
    if (view.status === "failed") throw new Error(view.error_message || "Underwriting failed.");
  }
  throw new Error("Timed out. Please try again.");
}
```

Example chat handler:

```js
async function onSend(address) {
  // Require Google sign-in before running.
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return signInWithGoogle();   // then re-run onSend(address)

  appendBotMessage(`Running analysis on ${address}…`);
  try {
    const report = await runUnderwrite(address, {
      onProgress: (step) => updateProgress(step), // 1..8
      sessionToken: token,
    });
    renderReportCard(report); // report.arv, report.estimated_rent, report.sale_comps, ...
  } catch (e) {
    if (e.message === "NEED_SIGNIN") return signInWithGoogle();      // then retry
    if (e.message === "TRIAL_EXHAUSTED") return showSignupPaywall(); // 2 free used
    appendBotMessage(e.message);
  }
}

function signInWithGoogle() {
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: window.location.origin },
  });
}
```

## The report shape you'll render

```jsonc
{
  "status": "complete",
  "address": "1112 E Malibu Dr, Tempe, AZ 85282, USA",
  "arv": 561200, "arv_range_low": 493700, "arv_range_high": 629800,
  "estimated_rent": 2270, "rent_range_low": 1815, "rent_range_high": 2730,
  "comps_analyzed": 50,
  "sale_comps": [ /* 5 comps: address, price_per_sqft, ai_notes, … */ ],
  "rent_comps": [ /* 5 comps */ ],
  "data_quality": { "sale": "ok", "rent": "ok" },
  "notes": [ "ARV and rent are derived from the final comparable sets." ],
  "cached": true        // present only when served from the 7-day cache
}
```

## Notes
- Never put the Supabase **service role** key or any provider key (Google,
  RentCast, Anthropic) in the browser — only the publishable anon key belongs here.
- Free-trial homepage visitors: call without `x-signal-api-key`. Logged-in users:
  pass their `sgl_…` key so repeats are cached and their history is saved.
- Never surface the underlying data sources to end users (product rule).
