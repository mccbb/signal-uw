#!/usr/bin/env node
// Signal UW — MCP server. Lets a user's own AI (Claude Desktop, ChatGPT, etc.)
// underwrite a property by calling the Signal /underwrite engine with their
// personal Signal API key. The engine is the single source of truth; this server
// is just a thin tool wrapper (spec §8).
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// --- Config (set SIGNAL_API_KEY; the rest have sensible defaults) -----------
const API_URL = process.env.SIGNAL_API_URL ??
  "https://nmguadctlkhunkfhfimb.supabase.co/functions/v1/underwrite";
// Publishable anon key — used only to pass the Supabase API gateway. Safe to ship.
const ANON_KEY = process.env.SIGNAL_ANON_KEY ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5tZ3VhZGN0bGtodW5rZmhmaW1iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MTU5MTMsImV4cCI6MjA4ODk5MTkxM30.6xUHNn04v0hcylx4yQJxAc_j0RCBH2TwPbBTYailG84";
const SIGNAL_API_KEY = process.env.SIGNAL_API_KEY ?? "";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_TRIES = 45; // ~90s ceiling for a live underwrite

const baseHeaders = () => ({
  "Content-Type": "application/json",
  "apikey": ANON_KEY,
  "x-signal-api-key": SIGNAL_API_KEY,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function underwrite(address) {
  if (!SIGNAL_API_KEY) {
    throw new Error("SIGNAL_API_KEY is not set. Add your Signal API key to this MCP server's config.");
  }
  // Create the job (or get an instant cache hit).
  const res = await fetch(API_URL, {
    method: "POST",
    headers: baseHeaders(),
    body: JSON.stringify({ address }),
  });
  const created = await res.json();
  if (res.status === 401) throw new Error("Invalid Signal API key.");
  if (res.status === 400) throw new Error(created?.error ?? "Bad request.");

  // Cache hit / already complete → return immediately.
  if (created?.status === "complete" || created?.arv !== undefined) return created;

  const jobId = created?.job_id;
  if (!jobId) throw new Error(`Unexpected response: ${JSON.stringify(created)}`);

  // Poll until the engine finishes.
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    await sleep(POLL_INTERVAL_MS);
    const pollRes = await fetch(`${API_URL}?job_id=${jobId}`, { headers: baseHeaders() });
    const view = await pollRes.json();
    if (view?.status === "complete") return view;
    if (view?.status === "failed") {
      throw new Error(view?.error_message ?? "Underwriting failed.");
    }
  }
  throw new Error("Timed out waiting for the underwriting to finish.");
}

async function getHistory() {
  if (!SIGNAL_API_KEY) {
    throw new Error("SIGNAL_API_KEY is not set. Add your Signal API key to this MCP server's config.");
  }
  const res = await fetch(`${API_URL}?history=1`, { headers: baseHeaders() });
  const data = await res.json();
  if (res.status === 401) throw new Error("Invalid Signal API key.");
  return data;
}

// --- MCP wiring -------------------------------------------------------------
const server = new Server(
  { name: "signal-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const TOOLS = [
  {
    name: "underwrite_property",
    description:
      "Underwrite a US residential property by address. Returns ARV (after-repair value), " +
      "estimated monthly rent, value ranges, and the comparable properties used. " +
      "Takes 20-40 seconds for a fresh address; repeats within 7 days are instant.",
    inputSchema: {
      type: "object",
      properties: {
        address: {
          type: "string",
          description: "Full US property address, e.g. '1112 E Malibu Dr, Tempe AZ 85282'.",
        },
      },
      required: ["address"],
    },
  },
  {
    name: "get_history",
    description: "List the underwritings you've previously run (address, date, ARV, estimated rent).",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    let result;
    if (name === "underwrite_property") {
      result = await underwrite(String(args?.address ?? "").trim());
    } else if (name === "get_history") {
      result = await getHistory();
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return {
      isError: true,
      content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("signal-mcp running (stdio)");
