import { appendFile } from "node:fs/promises";

const baseURL = process.env.FIELD_ASSIST_BASE_URL;
const cookie = process.env.FIELD_ASSIST_SUPPORT_COOKIE;
const tracePath = process.env.FIELD_ASSIST_TRACE_PATH;

if (!baseURL || !cookie || !tracePath) {
  process.stderr.write("Field Assist eval MCP requires base URL, support cookie, and trace path.\n");
  process.exit(1);
}

const manifestResponse = await fetch(`${baseURL}/__gofastr/webmcp/tools.json`, {
  headers: { Accept: "application/json", Cookie: cookie },
});
if (!manifestResponse.ok) {
  throw new Error(`WebMCP manifest returned ${manifestResponse.status}`);
}
const manifest = await manifestResponse.json();
const tools = new Map(manifest.tools.map((tool) => [tool.name, tool]));

async function record(entry) {
  await appendFile(tracePath, `${JSON.stringify(entry)}\n`, "utf8");
}

async function callTool(name, input) {
  const tool = tools.get(name);
  if (!tool) throw new Error(`Unknown Field Assist tool: ${name}`);
  const started = Date.now();
  const response = await fetch(new URL(tool.path, baseURL), {
    method: tool.method,
    headers: {
      Accept: "application/json",
      Cookie: cookie,
      Origin: baseURL,
      Referer: `${baseURL}/`,
      "X-Gofastr-WebMCP": "1",
      ...(tool.method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    body: tool.method === "POST" ? JSON.stringify(input ?? {}) : undefined,
  });
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  await record({
    at: new Date().toISOString(),
    tool: name,
    input: input ?? {},
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - started,
  });
  return {
    content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
    isError: !response.ok,
  };
}

async function handle(message) {
  if (message.method === "initialize") {
    return {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "field-assist-eval", version: "1.0.0" },
    };
  }
  if (message.method === "ping") return {};
  if (message.method === "tools/list") {
    return {
      tools: manifest.tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: Boolean(tool.readOnlyHint),
          destructiveHint: false,
          idempotentHint: Boolean(tool.readOnlyHint),
          openWorldHint: false,
        },
      })),
    };
  }
  if (message.method === "tools/call") {
    return callTool(message.params?.name, message.params?.arguments ?? {});
  }
  if (message.method?.startsWith("notifications/")) return undefined;
  throw new Error(`Unsupported MCP method: ${message.method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
      const result = await handle(message);
      if (message.id !== undefined && result !== undefined) {
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
      }
    } catch (error) {
      if (message?.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: error.message } })}\n`,
        );
      }
    }
  }
});
