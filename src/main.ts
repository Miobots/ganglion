
import { createGanglionMcpServer } from "./mcp/bootstrap.ts";
import { BrainWebSocketTransport } from "./mcp/brain-websocket-transport.ts";
import { parseFilesystemPolicy } from "./mcp/filesystem/policy.ts";

const brainUrl = process.env.BRAIN_WS_URL ?? "ws://127.0.0.1:8080/ws";
const deviceId = process.env.GANGLION_DEVICE_ID;
const token = process.env.DEV_TOKEN;
const filesystem = parseFilesystemPolicy(process.env.GANGLION_FILESYSTEM_POLICY);
const allowFilesystemActions = process.env.MCP_DEV_ALLOW_FILESYSTEM_ACTIONS === "true";

if (!deviceId) {
  throw new Error("GANGLION_DEVICE_ID is required");
}

if (!token) {
  throw new Error("DEV_TOKEN is required");
}

const transport = new BrainWebSocketTransport({
  url: brainUrl,
  deviceId,
  token,
});

const mcpServer = await createGanglionMcpServer(transport, {
  ...(filesystem ? { filesystem } : {}),
  ...(allowFilesystemActions ? {
    approvalProvider: {
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async (request) => {
        const allowed = request.toolName.startsWith("filesystem.");
        if (allowed) console.info(`[Ganglion] MCP DEV filesystem action enabled tool=${request.toolName} target=${request.target ?? "unknown"}`);
        return allowed;
      },
    },
  } : {}),
});

await mcpServer.start();

console.log("[Ganglion] MCP server is running");
console.log(`[Ganglion] Device ID: ${deviceId}`);
console.log(`[Ganglion] Brain: ${brainUrl}`);
console.log("[Ganglion] Available tools:");

for (const tool of mcpServer.registry.listEnabled()) {
  console.log(`  - ${tool.name}`);
}

async function shutdown(): Promise<void> {
  console.log("\n[Ganglion] Shutting down...");
  await mcpServer.close();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
