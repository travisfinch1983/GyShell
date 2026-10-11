// mcp-marinara-builder — exposes Marinara's character-builder tool bridge as an MCP
// server for the Hermes `character-builder` agent. Each tool call is forwarded to the
// marinara-dev backend's POST /api/builder/tool, which mutates the server-held working
// card keyed by conversationId (the agent's `session` arg). Cloned from mcp-marinara-mari.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Base is the /api/builder prefix; we POST to `${BASE}/tool`.
const BASE = (process.env.MARINARA_BUILDER_URL || "http://10.0.0.141:7870/api/builder").replace(/\/$/, "");
const BASIC_USER = process.env.MARINARA_BASIC_USER || "";
const BASIC_PASS = process.env.MARINARA_BASIC_PASS || "";
const AUTH = "Basic " + Buffer.from(`${BASIC_USER}:${BASIC_PASS}`).toString("base64");
const SPEC = JSON.parse(fs.readFileSync(path.join(__dirname, "builder-tools-spec.json"), "utf-8"));

const server = new Server({ name: "marinara-builder", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: SPEC.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema || { type: "object", properties: {} },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = { ...(args || {}) };
  // The agent may pass `session` (its conversationId); lift it to the top-level
  // conversationId the bridge routes on, and don't forward it as a tool argument.
  const session = typeof a.session === "string" ? a.session : "";
  delete a.session;
  try {
    const res = await fetch(`${BASE}/tool`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: AUTH },
      body: JSON.stringify({ conversationId: session, tool: name, arguments: a }),
      signal: AbortSignal.timeout(120000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { content: [{ type: "text", text: `Bridge error ${res.status}: ${text}` }], isError: true };
    }
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return { content: [{ type: "text", text: `Bridge call failed: ${err?.message || err}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mcp-marinara-builder] ready — ${SPEC.length} tools -> ${BASE}`);
