import { DefaultPermissionManager } from "./permissions.ts";
import { filesystemTools, InMemoryAuditLog, SecureFilesystem } from "./filesystem.ts";
import { GanglionMcpServer, type GanglionMcpServerOptions } from "./server.ts";
import { SystemStatusAdapter } from "./system-status.ts";
import type { FilesystemPolicy, GanglionTransport } from "./types.ts";

export interface GanglionBootstrapOptions extends GanglionMcpServerOptions {
  filesystem?: FilesystemPolicy;
}

export async function createGanglionMcpServer(
  transport: GanglionTransport,
  options: GanglionBootstrapOptions = {},
): Promise<GanglionMcpServer> {
  const tools = [...(options.tools ?? [])];
  if (options.filesystem) {
    const filesystem = new SecureFilesystem(options.filesystem, new InMemoryAuditLog());
    await filesystem.initialize();
    tools.push(...filesystemTools(filesystem));
  }
  const adapters = [new SystemStatusAdapter(), ...(options.adapters ?? [])];
  return new GanglionMcpServer(transport, { ...options, tools, adapters });
}
