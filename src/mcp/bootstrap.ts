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
import { AppLauncherAdapter, type AppLauncherPolicy, type RegisteredAppOrUrl } from "./adapters/app-launcher.ts";
import { MediaControlAdapter, type VolumeCommand } from "./adapters/media-control.ts";
import { ScriptRunnerAdapter, type RegisteredScript } from "./adapters/script-runner.ts";
import { ConnectorAdapter } from "./adapters/connectors.ts";
import type { ConnectorConfig } from "../pairing.ts";

export interface GanglionBootstrapOptions extends GanglionMcpServerOptions {
  filesystem?: FilesystemPolicy;
  processManagement?: ProcessManagementConfiguration;
  appLauncher?: AppLauncherPolicy;
  /** Scripts a human registered for `run_script` (G2.2). */
  scripts?: RegisteredScript[];
  /** MCP servers a human added (G6.2). One that fails to start is skipped, never fatal. */
  connectors?: ConnectorConfig[];
  /** How a registered app is opened; inside the jail, by asking the broker outside (GANGLION_DECISIONS 36). */
  launchApp?: (entry: RegisteredAppOrUrl) => Promise<void>;
  /** How volume is changed; inside the jail, by the broker (no PipeWire socket in there). */
  setVolume?: (command: VolumeCommand) => Promise<void>;
}

export async function createGanglionMcpServer(
  transport: GanglionTransport,
  options: GanglionBootstrapOptions = {},
): Promise<GanglionMcpServer> {
  const adapters = [
    new SystemStatusAdapter(),
    new ScreenCaptureAdapter(),
    new MediaControlAdapter(undefined, undefined, options.setVolume),
    ...(options.adapters ?? []),
  ];
  if (options.scripts?.length) adapters.push(new ScriptRunnerAdapter(options.scripts));
  for (const connector of options.connectors ?? []) {
    try {
      adapters.push(await ConnectorAdapter.connect(connector));
    } catch (error) {
      console.warn(`[Ganglion] Connector ${connector.name} did not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.appLauncher) {
    adapters.push(new AppLauncherAdapter({ policy: options.appLauncher, ...(options.launchApp ? { launcher: options.launchApp } : {}) }));
  }
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
