# signal-mcp

The Signal UW MCP server. Install it into your own AI client (Claude Desktop,
ChatGPT desktop, Cursor, etc.) and underwrite properties by just asking:

> "Underwrite 1112 E Malibu Dr, Tempe AZ 85282"

It's a thin wrapper around the Signal `/underwrite` engine — all the real work
(comps, scoring, AI refinement, ARV/rent) happens server-side. This process only
forwards your request using **your** Signal API key.

## Tools

- **`underwrite_property(address)`** — full underwriting report: ARV + range,
  estimated rent + range, comps analyzed, and the final comparable sets.
- **`get_history()`** — your previously-run underwritings (address, date, ARV, rent).

## What you need

- **Node 18+**
- **Your Signal API key** (`sgl_…`) — generated on your Signal account page.

## Install (Claude Desktop)

1. Get the code: `git clone <signal-mcp repo>` then `npm install` inside it.
2. Open Claude Desktop → Settings → Developer → Edit Config, and add:

```json
{
  "mcpServers": {
    "signal": {
      "command": "node",
      "args": ["/absolute/path/to/signal-mcp/index.mjs"],
      "env": {
        "SIGNAL_API_KEY": "sgl_your_key_here"
      }
    }
  }
}
```

3. Restart Claude Desktop. You'll see the `signal` tools available, then ask it to
   underwrite any US address.

> Once published to npm, the `command`/`args` can become
> `"command": "npx", "args": ["-y", "signal-mcp"]` — no clone needed.

## ChatGPT / other MCP clients

Any MCP-compatible client works. Point it at `index.mjs` over stdio with
`SIGNAL_API_KEY` set, the same way. (ChatGPT's custom connectors also support
remote MCP; a hosted/remote version of this server can be added later.)

## Config (env)

| Var | Required | Default |
|---|---|---|
| `SIGNAL_API_KEY` | **yes** | — (your `sgl_…` key) |
| `SIGNAL_API_URL` | no | the Signal `/underwrite` endpoint |
| `SIGNAL_ANON_KEY` | no | the project's publishable gateway key (safe to ship) |

## Notes

- A fresh address takes ~20–40s (the engine runs 8 steps incl. two AI calls).
  A repeat of the same address within 7 days returns instantly from your cache.
- An invalid/missing key returns a clear error; nothing is charged.
- This is **not** how the signaluw.com website chat talks to the engine — that
  calls the REST endpoint directly. See `docs/homepage-chat-wiring.md`.
