# Signal UW — usage tracking & owner dashboard (setup)

Two things this adds:

1. **Phone/Slack alerts** when someone gives an email ("test it out") or signs up with Google.
2. An **owner-only dashboard** (`/admin`, linked in the navbar dropdown only for you) summarising users, visits, activity, video/demo, bounces, and conversions.

The repo half (Supabase migration + 2 edge functions) is done. This file is the
checklist for the manual config + the Bolt frontend (which isn't in this repo).

---

## What's in the repo already

- `supabase/migrations/0008_owner_notifications_and_admin_stats.sql`
  - enables `pg_net`
  - `public.notify_owner(event, data)` → POSTs to the `notify-owner` function (URL + secret read from Vault)
  - triggers on `public.leads` (email capture) and `auth.users` (signup)
  - `public.admin_overview(days)` → all backend metrics in one call
- `supabase/functions/notify-owner/` → formats the event, posts to Slack + ntfy
- `supabase/functions/admin-stats/` → owner-gated; returns `admin_overview` + a PostHog traffic summary
- `supabase/config.toml` → registers both functions

**Deploy:** push to `main`. Supabase's GitHub integration applies the migration;
the `deploy-functions.yml` Action deploys the two functions. (Per the project rule,
nothing here is applied directly via the Supabase MCP.)

---

## Step 1 — Slack incoming webhook (≈3 min)

1. Create/choose a Slack channel (e.g. `#signal-alerts`).
2. https://api.slack.com/apps → **Create New App** → From scratch.
3. **Incoming Webhooks** → On → **Add New Webhook to Workspace** → pick the channel.
4. Copy the `https://hooks.slack.com/services/...` URL.

## Step 2 — ntfy phone push (≈3 min)

ntfy is a free push-to-phone app (no account needed).

1. Install **ntfy** from the App Store / Play Store.
2. Pick a hard-to-guess topic name, e.g. `signal-uw-mac-9f3k2x` (anyone who knows
   the topic can read it, so make it unguessable).
3. In the app: **Subscribe to topic** → enter that name.
4. Your full URL is `https://ntfy.sh/signal-uw-mac-9f3k2x`.

## Step 3 — Edge function secrets

Supabase dashboard → **Edge Functions → Secrets** → add:

| Name | Value |
|---|---|
| `WEBHOOK_SECRET` | any long random string (used to authenticate the DB → function call) |
| `SLACK_WEBHOOK_URL` | from Step 1 |
| `NTFY_URL` | `https://ntfy.sh/<your-topic>` from Step 2 |
| `OWNER_USER_ID` | your row's UUID from `auth.users` (Authentication → Users → your account) |
| `POSTHOG_PROJECT_ID` | numeric project id (Step 5) |
| `POSTHOG_API_KEY` | a **personal** API key, `phx_...` (Step 5) |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` are already set.

## Step 4 — Vault secrets (so triggers can call the function, no secrets in git)

Dashboard → **Project Settings → Vault** (or run as SQL in the SQL editor). Add two
secrets named exactly:

- `notify_url` = `https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/notify-owner`
- `notify_secret` = the **same** value you used for `WEBHOOK_SECRET` above

SQL form (run in the SQL editor — these contain a secret, so don't commit them):

```sql
select vault.create_secret('https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/notify-owner', 'notify_url');
select vault.create_secret('PASTE_THE_SAME_WEBHOOK_SECRET', 'notify_secret');
```

> If `pg_net` isn't enabled by the migration on your plan, enable it under
> **Database → Extensions** (search `pg_net`). It's on by default for most projects.

Test the alert path after deploy:

```sql
insert into public.leads (email, address) values ('test@example.com', '123 Test St');
```

You should get a Slack message and an ntfy push within a couple seconds. Delete the
test row afterward.

---

## Step 5 — PostHog (frontend analytics: visits, video, demo, bounces)

The backend (signups, leads, reports, conversions) comes straight from your DB.
Everything that happens *in the browser before a request* — visits, video plays,
demo starts, bounces — needs PostHog.

1. Sign up at https://posthog.com (free tier is generous).
2. Project settings → copy the **Project API key** (`phc_...`) for the browser snippet below.
3. Settings → **Personal API keys** → create one (`phx_...`) → put it in `POSTHOG_API_KEY` (Step 3).
4. Note the numeric **Project ID** → `POSTHOG_PROJECT_ID` (Step 3).

### Add PostHog to the Bolt site

Install (`npm i posthog-js`) and init once at app start:

```ts
import posthog from "posthog-js";

posthog.init("phc_YOUR_PROJECT_KEY", {
  api_host: "https://us.posthog.com",
  capture_pageview: true,      // gives you visits + bounce data automatically
});
```

Identify users after Google login so backend + frontend data line up:

```ts
// after supabase.auth.getUser()
posthog.identify(user.id, { email: user.email });
```

Fire the three custom events the dashboard reads (names must match exactly):

```ts
// when the demo video starts playing
posthog.capture("video_played");

// when someone starts the demo / submits the first address
posthog.capture("demo_started");

// when an underwrite result is shown
posthog.capture("demo_completed");
```

(`$pageview` and `$session_id` are captured automatically — that's where visits and
the bounce-rate proxy come from.)

---

## Step 6 — Owner-only navbar link + dashboard page (Bolt)

### Gate the dropdown link to just you

```tsx
const OWNER_EMAIL = "mac@maccobb.com";
// inside your dropdown menu:
{user?.email === OWNER_EMAIL && (
  <DropdownItem onClick={() => navigate("/admin")}>Dashboard</DropdownItem>
)}
```

> This only hides the link. The real protection is the `OWNER_USER_ID` check inside
> the `admin-stats` function — even if someone hits `/admin` directly, they get 403.

### The dashboard page

Add a route `/admin` that calls the function with the signed-in session token:

```tsx
import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase"; // your existing client

export default function AdminDashboard() {
  const [data, setData] = useState<any>(null);
  const [days, setDays] = useState(30);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/admin-stats?days=${days}`,
        { headers: { Authorization: `Bearer ${session?.access_token}` } },
      );
      if (!res.ok) { setErr(`${res.status}`); return; }
      setData(await res.json());
    })();
  }, [days]);

  if (err) return <div>Not authorized ({err})</div>;
  if (!data) return <div>Loading…</div>;

  const b = data.backend, t = data.traffic ?? {};
  const Stat = ({ label, value }: { label: string; value: any }) => (
    <div style={{ padding: 16, border: "1px solid #eee", borderRadius: 12 }}>
      <div style={{ fontSize: 12, color: "#888" }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700 }}>{value ?? "—"}</div>
    </div>
  );

  return (
    <div style={{ padding: 24 }}>
      <h1>Signal — usage</h1>
      <select value={days} onChange={(e) => setDays(+e.target.value)}>
        <option value={7}>Last 7 days</option>
        <option value={30}>Last 30 days</option>
        <option value={90}>Last 90 days</option>
      </select>

      <h3>Acquisition</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <Stat label="Unique visitors" value={t.unique_visitors} />
        <Stat label="Pageviews" value={t.pageviews} />
        <Stat label="Bounce rate" value={t.bounce_rate != null ? `${t.bounce_rate}%` : "—"} />
        <Stat label="Leads (window)" value={b.leads_in_window} />
      </div>

      <h3>Engagement</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <Stat label="Video plays" value={t.video_plays} />
        <Stat label="Demos started" value={t.demo_starts} />
        <Stat label="Demos completed" value={t.demo_completes} />
        <Stat label="Reports run (window)" value={b.reports_in_window} />
      </div>

      <h3>Users & conversion</h3>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12 }}>
        <Stat label="Total users" value={b.users_total} />
        <Stat label="New users (window)" value={b.users_new_in_window} />
        <Stat label="Paying subscribers" value={b.paying_subscribers} />
        <Stat label="Failed jobs (window)" value={b.jobs_failed_in_window} />
      </div>

      <h3>Recent signups</h3>
      <ul>
        {b.recent_signups.map((s: any, i: number) => (
          <li key={i}>{s.email} — {new Date(s.at).toLocaleString()}</li>
        ))}
      </ul>
    </div>
  );
}
```

`b.signups_by_day` and `b.reports_by_day` are arrays of `{day, count}` if you want
to add a chart later.

---

## What you're now tracking (and why)

Read top-to-bottom as a funnel:

- **Acquisition** — unique visitors, pageviews, bounce rate (PostHog), leads captured (DB).
- **Engagement** — video plays, demo started, demo completed (PostHog), reports run (DB).
- **Users** — total + new signups, daily trend (DB).
- **Activation** — reports run per window, verdict mix (Buy/Pass/Review), failed-job rate (DB).
- **Conversion** — paying subscribers by plan (DB).

The gaps to watch: a big drop from *visitors → demo started* means the landing page
isn't selling the demo; *demo completed → signup* means the result isn't compelling
enough to register; *signup → paying* is your monetisation funnel.
