import "dotenv/config";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const NODE_RED_URL = process.env.NODE_RED_URL;
const NODE_RED_USERNAME = process.env.NODE_RED_USERNAME;
const NODE_RED_PASSWORD = process.env.NODE_RED_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!NODE_RED_URL || !NODE_RED_USERNAME || !NODE_RED_PASSWORD) {
  console.error("NODE_RED_URL, NODE_RED_USERNAME, and NODE_RED_PASSWORD must be set");
  process.exit(1);
}

const NODE_RED_BASIC_AUTH = Buffer.from(`${NODE_RED_USERNAME}:${NODE_RED_PASSWORD}`).toString("base64");

// Single helper — every tool result includes ok + debug so failures are visible
// to the caller instead of being swallowed by the MCP layer.
async function nrFetch(path, { method = "GET", body } = {}) {
  const url = `${NODE_RED_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${NODE_RED_BASIC_AUTH}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty/non-JSON body is fine, e.g. 204 on deploy */
  }
  return {
    ok: res.ok,
    debug: { status: res.status, endpoint: `${method} ${path}` },
    data: json,
  };
}

function toolResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function buildServer() {
  const server = new McpServer({ name: "nodered-mcp", version: "0.1.0" });

  server.tool(
    "list_flows",
    "List Node-RED flow tabs (name + id) without their node contents.",
    {},
    async () => {
      const r = await nrFetch("/flows");
      const tabs = r.ok
        ? (r.data?.flows ?? []).filter((n) => n.type === "tab")
            .map((t) => ({ id: t.id, label: t.label, disabled: !!t.disabled }))
        : null;
      return toolResult({ ok: r.ok, debug: r.debug, flows: tabs });
    }
  );

  server.tool(
    "get_flow",
    "Get the full JSON for a single flow tab by id.",
    { id: z.string().describe("Flow tab id") },
    async ({ id }) => {
      const r = await nrFetch(`/flow/${encodeURIComponent(id)}`);
      return toolResult({ ok: r.ok, debug: r.debug, flow: r.data });
    }
  );

  server.tool(
    "deploy_flow",
    "Deploy (replace) a single flow tab by id via PUT /flow/:id. Never touches other tabs. " +
      "Always reads the existing tab first so an overwrite that changes node count is visible in the logs.",
    {
      id: z.string().describe("Flow tab id to replace"),
      flow: z.object({}).passthrough().describe("Full flow object: {id, label, nodes: [...]}"),
    },
    async ({ id, flow }) => {
      const incomingNodeCount = Array.isArray(flow?.nodes) ? flow.nodes.length : 0;

      const before = await nrFetch(`/flow/${encodeURIComponent(id)}`);
      const existingNodeCount = Array.isArray(before.data?.nodes) ? before.data.nodes.length : null;

      console.log(
        `[deploy_flow] id=${id} existingNodeCount=${existingNodeCount} incomingNodeCount=${incomingNodeCount}`
      );

      const r = await nrFetch(`/flow/${encodeURIComponent(id)}`, { method: "PUT", body: flow });
      return toolResult({
        ok: r.ok,
        debug: { ...r.debug, existingNodeCount, incomingNodeCount },
        result: r.data,
      });
    }
  );

  server.tool(
    "create_flow",
    "Create a new flow tab via POST /flow (singular — scoped, does not touch existing tabs).",
    {
      label: z.string().describe("Name for the new tab"),
      nodes: z.array(z.object({}).passthrough()).default([]).describe("Nodes to seed the new tab with"),
    },
    async ({ label, nodes }) => {
      const r = await nrFetch("/flow", { method: "POST", body: { label, nodes } });
      return toolResult({ ok: r.ok, debug: r.debug, result: r.data });
    }
  );

  server.tool(
    "get_nodes",
    "List installed Node-RED node modules.",
    {},
    async () => {
      const r = await nrFetch("/nodes");
      return toolResult({ ok: r.ok, debug: r.debug, nodes: r.data });
    }
  );

  server.tool(
    "get_context",
    "Read Node-RED global context variables (requires Context API enabled on the target instance).",
    {},
    async () => {
      const r = await nrFetch("/context/global");
      return toolResult({ ok: r.ok, debug: r.debug, context: r.data });
    }
  );

  // NOTE: this installs an arbitrary npm package into the Node-RED runtime,
  // which can execute install-script code with whatever privileges that
  // process has (HA-integrated automation control, in this deployment).
  // There is no allowlist here — anything callable by this tool is callable
  // by whatever can reach it. Treat as equivalent in risk to shell access.
  server.tool(
    "install_modules",
    "Install a Node-RED node module by npm package name via POST /nodes. " +
      "WARNING: this runs `npm install` inside the Node-RED runtime — equivalent to arbitrary code execution there.",
    { module: z.string().describe("npm package name, e.g. node-red-contrib-bigtimer") },
    async ({ module }) => {
      console.log(`[install_modules] module=${module}`);
      const r = await nrFetch("/nodes", { method: "POST", body: { module } });
      return toolResult({ ok: r.ok, debug: r.debug, result: r.data });
    }
  );

  return server;
}

const app = express();
app.use(express.json());

const MCP_API_KEY = process.env.MCP_API_KEY;
if (!MCP_API_KEY) {
  console.error("MCP_API_KEY must be set");
  process.exit(1);
}

app.use("/mcp", (req, res, next) => {
  const key = req.headers["x-api-key"];
  if (!key || key !== MCP_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Stateless streamable-HTTP: fresh server+transport per request.
// Simpler and safer for a small internal tool — no session store to leak or expire.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("MCP request error:", err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

// GET/DELETE are part of the Streamable HTTP spec for server-initiated
// notifications/session teardown — not used in stateless mode, but respond
// cleanly instead of 404ing so well-behaved clients don't choke.
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed (stateless server)" }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed (stateless server)" }));

app.listen(PORT, () => console.log(`nodered-mcp listening on :${PORT}`));
