import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express from "express";
import { z } from "zod";

const KANBOX_API_KEY = process.env.KANBOX_API_KEY;
const PORT = process.env.PORT || 3000;
const KANBOX_BASE = "https://api.kanbox.io";

function createServer() {
  const server = new McpServer({ name: "kanbox-mcp", version: "1.0.0" });

  server.tool("kanbox_search_members",
    "Search inbox, connections, or unread messages in Kanbox",
    {
      q: z.string().optional().describe("Fuzzy name search"),
      type: z.enum(["inbox", "unread_inbox", "connections"]).optional().describe("Filter by member type"),
      limit: z.number().optional().describe("Max results 1-100"),
      offset: z.number().optional().describe("Results to skip")
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.q) params.set("q", args.q);
      if (args.type) params.set("type", args.type);
      if (args.limit) params.set("limit", String(args.limit));
      if (args.offset) params.set("offset", String(args.offset));
      const r = await fetch(`${KANBOX_BASE}/public/members?${params}`, {
        headers: { "X-API-Key": KANBOX_API_KEY }
      });
      const data = await r.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("kanbox_search_leads",
    "Search scraped leads in Kanbox by list name or query",
    {
      name: z.string().optional().describe("List name filter"),
      q: z.string().optional().describe("Search query"),
      limit: z.number().optional().describe("Max results 1-100")
    },
    async (args) => {
      const params = new URLSearchParams();
      if (args.name) params.set("name", args.name);
      if (args.q) params.set("q", args.q);
      if (args.limit) params.set("limit", String(args.limit));
      const r = await fetch(`${KANBOX_BASE}/public/leads?${params}`, {
        headers: { "X-API-Key": KANBOX_API_KEY }
      });
      const data = await r.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("kanbox_list_lists",
    "Get all Kanbox lead lists",
    {},
    async () => {
      const r = await fetch(`${KANBOX_BASE}/public/lists`, {
        headers: { "X-API-Key": KANBOX_API_KEY }
      });
      const data = await r.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("kanbox_get_messages",
    "Get conversation messages from Kanbox",
    { conversation_id: z.number().describe("Conversation ID") },
    async ({ conversation_id }) => {
      const r = await fetch(`${KANBOX_BASE}/public/messages?conversation_id=${conversation_id}`, {
        headers: { "X-API-Key": KANBOX_API_KEY }
      });
      const data = await r.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool("kanbox_add_lead_url",
    "Add a lead to Kanbox by LinkedIn URL",
    {
      linkedin_profile_url: z.string().describe("Full LinkedIn profile URL"),
      list: z.string().describe("Kanbox list name")
    },
    async ({ linkedin_profile_url, list }) => {
      const r = await fetch(`${KANBOX_BASE}/public/leadurl`, {
        method: "POST",
        headers: { "X-API-Key": KANBOX_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ linkedin_profile_url, list })
      });
      const data = await r.json();
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// OAuth metadata discovery - required by MCP 2025-03-26 spec for Perplexity
app.get("/.well-known/oauth-authorization-server", (req, res) => {
  const base = `${req.protocol}://${req.get("host")}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"]
  });
});

// OAuth dynamic client registration
app.post("/oauth/register", (req, res) => {
  const clientId = `client_${Date.now()}`;
  res.status(201).json({
    client_id: clientId,
    client_secret: "not-used",
    redirect_uris: req.body.redirect_uris || [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none"
  });
});

// Streamable HTTP (Claude, Perplexity with streamable-http)
app.all("/mcp", async (req, res) => {
  const server = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE transport (Perplexity SSE mode)
const sseTransports = {};
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  sseTransports[transport.sessionId] = transport;
  res.on("close", () => delete sseTransports[transport.sessionId]);
  const server = createServer();
  await server.connect(transport);
});
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = sseTransports[sessionId];
  if (!transport) return res.status(404).json({ error: "Session not found" });
  await transport.handlePostMessage(req, res);
});

app.get("/", (req, res) => res.json({ status: "Kanbox MCP server running", endpoints: ["/mcp", "/sse"] }));
app.listen(PORT, () => console.log(`Kanbox MCP server on port ${PORT}`));
