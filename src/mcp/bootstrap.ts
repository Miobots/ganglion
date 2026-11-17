import { DefaultPermissionManager } from "./permissions.ts";
import { GanglionMcpServer, type GanglionMcpServerOptions } from "./server.ts";
import { SystemStatusAdapter } from "./adapters/system-status.ts";
import type { FilesystemPolicy, GanglionTransport } from "./types.ts";
import { ScreenCaptureAdapter } from "./adapters/screen-capture.ts";
import { FilesystemAdapter } from "./adapters/filesystem.ts";
import { ProcessAdapter } from "./adapters/process.ts";
import { ProcessCpuSampler } from "./process/process-cpu-sampler.ts";
import { ProcessInspector } from "./process/process-inspector.ts";
import { ProcessManager } from "./process/process-manager.ts";
import type { ProcessManagementConfiguration } from "./process/types.ts";

export interface GanglionBootstrapOptions extends GanglionMcpServerOptions {
  filesystem?: FilesystemPolicy;
  processManagement?: ProcessManagementConfiguration;
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
  if (options.processManagement?.enabled === true && process.platform === "linux") {
    const configuration = options.processManagement;
    const sampler = new ProcessCpuSampler({
      clockTicksPerSecond: configuration.clockTicksPerSecond,
      ...(configuration.sampleIntervalMs === undefined ? {} : { intervalMs: configuration.sampleIntervalMs }),
    });
    const inspector = new ProcessInspector({
      clockTicksPerSecond: configuration.clockTicksPerSecond,
      cpuSampler: sampler,
    });
    const manager = new ProcessManager({
      policy: {
        enabled: true,
        ...(configuration.protectedPids === undefined ? {} : { protectedPids: configuration.protectedPids }),
        ...(configuration.ganglionPid === undefined ? {} : { ganglionPid: configuration.ganglionPid }),
      },
      inspector,
    });
    adapters.push(new ProcessAdapter({ inspector, sampler, manager }));
  }
  return new GanglionMcpServer(transport, { ...options, adapters });
}
