
import { createGanglionMcpServer } from "./mcp/bootstrap.ts";
import { BrainWebSocketTransport } from "./mcp/brain-websocket-transport.ts";
import { parseFilesystemPolicy } from "./mcp/filesystem/policy.ts";
import { parseProcessManagementConfiguration } from "./mcp/process/policy.ts";
import { parseAppLauncherPolicy } from "./mcp/adapters/app-launcher.ts";
import { parseScripts } from "./mcp/adapters/script-runner.ts";
import { createDesktopApprovalSurface } from "./mcp/desktop-approval.ts";
import { parseTiers } from "./tiers.ts";
import { parseConnectors } from "./mcp/adapters/connectors.ts";
import { writeSync } from "node:fs";
import { readCredentials, readPairedConfig } from "./pairing.ts";
import { createGanglionDevApprovalProvider, parseGanglionDevAutoApproveProcessActions } from "./mcp/dev-approval.ts";

// What `bun run pair` saved; environment variables override it for development.
const credentials = await readCredentials();
const paired = await readPairedConfig();
const brainUrl = process.env.BRAIN_WS_URL ?? credentials?.brain_url ?? "ws://127.0.0.1:8080/ws";
const deviceId = process.env.GANGLION_DEVICE_ID ?? credentials?.device_id;
const token = process.env.GANGLION_TOKEN ?? credentials?.token;
const filesystem = parseFilesystemPolicy(
  process.env.GANGLION_FILESYSTEM_POLICY ?? (paired?.filesystem ? JSON.stringify(paired.filesystem) : undefined),
);
const processManagement = parseProcessManagementConfiguration(process.env.GANGLION_PROCESS_MANAGEMENT);
const appLauncher = parseAppLauncherPolicy(
  process.env.GANGLION_APP_ALLOWLIST ?? (paired?.appLauncher ? JSON.stringify(paired.appLauncher) : undefined),
);
const scripts = parseScripts(process.env.GANGLION_SCRIPTS ?? (paired?.scripts ? JSON.stringify(paired.scripts) : undefined));
const allowFilesystemActions = process.env.MCP_DEV_ALLOW_FILESYSTEM_ACTIONS === "true";
const allowProcessActions = parseGanglionDevAutoApproveProcessActions();

if (!deviceId || !token) {
  console.error("Ganglion is not paired yet. Run: bun run pair --folder <a folder Mio may read>");
  process.exit(1);
}

// In the jail (bun run start:confined) apps and volume go to the broker outside, by name only.
const brokerFd = process.env.GANGLION_BROKER_FD ? Number(process.env.GANGLION_BROKER_FD) : undefined;
const desktopApprovals = (process.env.GANGLION_DESKTOP_APPROVALS ?? String(paired?.desktopApprovals ?? false)) === "true";

const transport = new BrainWebSocketTransport({
  url: brainUrl,
  deviceId,
  token,
  ...(desktopApprovals ? { approvalSurface: createDesktopApprovalSurface() } : {}),
});

const mcpServer = await createGanglionMcpServer(transport, {
  ...(filesystem ? { filesystem } : {}),
  ...(processManagement ? { processManagement } : {}),
  ...(appLauncher ? { appLauncher } : {}),
  ...(scripts ? { scripts } : {}),
  ...(paired?.tiers ? { tiers: parseTiers(paired.tiers) } : {}),
  ...(paired?.connectors ? { connectors: parseConnectors(paired.connectors) } : {}),
  // In the jail (bun run start:confined) apps open outside it, by name only, through the broker.
  ...(brokerFd !== undefined ? {
    launchApp: async (entry: { name: string }) => { writeSync(brokerFd, `${JSON.stringify({ name: entry.name })}\n`); },
    setVolume: async (command: string) => { writeSync(brokerFd, `${JSON.stringify({ volume: command })}\n`); },
  } : {}),
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
