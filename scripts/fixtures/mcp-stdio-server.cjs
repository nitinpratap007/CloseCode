// Phase 30 E2E fixture — a real MCP server over stdio.
//
// The packaged app spawns this as a child process (`node mcp-stdio-server.cjs`)
// and speaks the real protocol to it: initialize, tools/list, tools/call,
// resources/list, resources/read, prompts/list, prompts/get. It is not a mock
// of MCP; it IS MCP, via the same SDK the app uses. The SDK path arrives in
// CC_MCP_SDK because a spawned fixture cannot resolve the app's asar.
//
// Output contract for the harness: nothing goes to stdout except protocol
// frames (the transport owns it), so diagnostics go to stderr.

const path = require("path");

// The fixture normally lives inside the repo and resolves the SDK by the
// usual walk-up. When it is copied elsewhere (the harness can set CC_MCP_SDK
// to the SDK's install root), that path wins instead.
function req(id) {
  const sdkRoot = process.env.CC_MCP_SDK;
  if (sdkRoot) return require(path.join(sdkRoot, id));
  return require(id.startsWith("zod") ? "zod" : `@modelcontextprotocol/sdk/${id}`);
}

const { McpServer } = req("server/mcp.js");
const { StdioServerTransport } = req("server/stdio.js");
const { z } = req("zod");

const server = new McpServer({ name: "cc-fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo text back, prefixed so the harness can tell it came from here.", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: "text", text: `p30-echo:${text}` }] }),
);

server.registerTool(
  "add",
  { description: "Add two numbers.", inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
  async ({ a, b }) => ({ content: [{ type: "text", text: `p30-sum:${a + b}` }] }),
);

server.registerTool(
  "explode",
  { description: "Always reports an MCP-level error.", inputSchema: {}, annotations: { destructiveHint: true } },
  async () => ({ content: [{ type: "text", text: "p30-explode" }], isError: true }),
);

server.registerResource("notes", "memo://notes", { description: "The fixture's one resource." }, async (uri) => ({
  contents: [{ uri: uri.href, text: "p30 resource body", mimeType: "text/plain" }],
}));

server.registerPrompt("review", { description: "Review a file.", argsSchema: { file: z.string() } }, async ({ file }) => ({
  messages: [{ role: "user", content: { type: "text", text: `P30 review ${file}` } }],
}));

(async () => {
  await server.connect(new StdioServerTransport());
  console.error("mcp-stdio-server: listening");
})().catch((err) => {
  console.error("mcp-stdio-server: failed to start:", err);
  process.exit(1);
});
