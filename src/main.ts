
import { createGanglionMcpServer } from "./mcp/bootstrap.ts";
import { BrainWebSocketTransport } from "./mcp/brain-websocket-transport.ts";
import { parseFilesystemPolicy } from "./mcp/filesystem/policy.ts";
import { parseProcessManagementConfiguration } from "./mcp/process/policy.ts";
import { parseAppLauncherPolicy } from "./mcp/adapters/app-launcher.ts";
import { createGanglionDevApprovalProvider, parseGanglionDevAutoApproveProcessActions } from "./mcp/dev-approval.ts";

const brainUrl = process.env.BRAIN_WS_URL ?? "ws://127.0.0.1:8080/ws";
const deviceId = process.env.GANGLION_DEVICE_ID;
const token = process.env.DEV_TOKEN;
const filesystem = parseFilesystemPolicy(process.env.GANGLION_FILESYSTEM_POLICY);
const processManagement = parseProcessManagementConfiguration(process.env.GANGLION_PROCESS_MANAGEMENT);
const appLauncher = parseAppLauncherPolicy(process.env.GANGLION_APP_ALLOWLIST);
const allowFilesystemActions = process.env.MCP_DEV_ALLOW_FILESYSTEM_ACTIONS === "true";
const allowProcessActions = parseGanglionDevAutoApproveProcessActions();

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
  ...(processManagement ? { processManagement } : {}),
  ...(appLauncher ? { appLauncher } : {}),
  ...(allowFilesystemActions || allowProcessActions ? {
    approvalProvider: createGanglionDevApprovalProvider({ allowFilesystemActions, allowProcessActions }),
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
