import { cpus, freemem, hostname, platform, release, totalmem, uptime } from "node:os";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";

const inputSchema: ToolSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export class SystemStatusAdapter implements CapabilityAdapter {
  readonly family = "system_status" as const;
  isAvailable(): boolean { return true; }
  tools(): RegisteredTool[] {
    return [{
      name: "system.get_status",
      description: "Return Ganglion host operating system and resource status.",
      inputSchema,
      permission: "read",
      family: this.family,
      enabled: true,
      handler: async () => ({
        hostname: hostname(),
        platform: platform(),
        release: release(),
        uptimeSeconds: uptime(),
        cpuCount: cpus().length,
        memory: { totalBytes: totalmem(), freeBytes: freemem() },
      }),
    }];
  }
}