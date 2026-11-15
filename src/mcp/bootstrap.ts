import { DefaultPermissionManager } from "./permissions.ts";
import { GanglionMcpServer, type GanglionMcpServerOptions } from "./server.ts";
import { SystemStatusAdapter } from "./adapters/system-status.ts";
import type { FilesystemPolicy, GanglionTransport } from "./types.ts";
import { ScreenCaptureAdapter } from "./adapters/screen-capture.ts";
import { FilesystemAdapter } from "./adapters/filesystem.ts";

export interface GanglionBootstrapOptions extends GanglionMcpServerOptions {
  filesystem?: FilesystemPolicy;
}

export async function createGanglionMcpServer(
  transport: GanglionTransport,
  options: GanglionBootstrapOptions = {},
): Promise<GanglionMcpServer> {
  const adapters = [
    new SystemStatusAdapter(),
    new ScreenCaptureAdapter(),
    ...(options.adapters ?? []),
  ];
  if (options.filesystem) {
    const filesystem = new FilesystemAdapter(options.filesystem);
    await filesystem.initialize();
    adapters.push(filesystem);
  }
  return new GanglionMcpServer(transport, { ...options, adapters });
}
