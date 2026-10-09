// Phase 30 E2E fixture — a real MCP server over Streamable HTTP.
//
// Loaded in-process by the harness (`require`d, not spawned): it binds
// 127.0.0.1:0 and hands the harness its actual port. The packaged app connects
// over real TCP with the real Streamable HTTP transport — the wire between
// them is HTTP, not a shortcut.
//
// Sessions are managed the way the SDK documents: the initialize POST opens a
// session (`mcp-session-id` from then on), every later request routes to the
// transport that session opened, and DELETE closes it.

const http = require("http");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");

function createServer() {
  const server = new McpServer({ name: "cc-http-fixture", version: "2.0.0" });
  server.registerTool(
    "ping",
    { description: "Answer with the fixture's name.", inputSchema: {}, annotations: { readOnlyHint: true } },
    async () => ({ content: [{ type: "text", text: "p30-http-pong" }] }),
  );
  server.registerTool(
    "add",
    { description: "Add two numbers over HTTP.", inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
    async ({ a, b }) => ({ content: [{ type: "text", text: `p30-http-sum:${a + b}` }] }),
  );
  return server;
}

async function startHttpFixture() {
  /** @type {Record<string, { transport: any, server: any }>} */
  const sessions = {};

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!req.url || !req.url.startsWith("/mcp")) {
          res.writeHead(404);
          res.end();
          return;
        }
        const sessionId = req.headers["mcp-session-id"];
        let session = typeof sessionId === "string" ? sessions[sessionId] : undefined;
        if (!session) {
          if (req.method !== "POST") {
            res.writeHead(400);
            res.end("No session.");
            return;
          }
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (id) => {
              sessions[id] = { transport, server };
            },
          });
          const server = createServer();
          transport.onclose = () => {
            if (transport.sessionId && sessions[transport.sessionId]) {
              delete sessions[transport.sessionId];
            }
          };
          await server.connect(transport);
          session = { transport, server };
        }
        await session.transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String((err && err.message) || err));
        } else {
          try {
            res.end();
          } catch {}
        }
      }
    })();
  });
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    close: () =>
      new Promise((resolve) => {
        for (const s of Object.values(sessions)) {
          try {
            void s.transport.close();
          } catch {}
        }
        httpServer.close(() => resolve());
      }),
  };
}

module.exports = { startHttpFixture };
