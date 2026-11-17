import { readdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { cpus, freemem, hostname, loadavg, platform, release, totalmem, uptime } from "node:os";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";

const inputSchema: ToolSchema = { type: "object", properties: {}, required: [], additionalProperties: false };

export interface BatteryStatus { percent: number; status: string }

/** First `BAT*` under Linux power_supply; null on a desktop, a VM, or any other platform. */
export async function readBattery(root = "/sys/class/power_supply"): Promise<BatteryStatus | null> {
  try {
    const name = (await readdir(root)).sort().find((entry) => entry.startsWith("BAT"));
    if (!name) return null;
    const percent = Number((await readFile(join(root, name, "capacity"), "utf8")).trim());
    const status = (await readFile(join(root, name, "status"), "utf8")).trim();
    return Number.isFinite(percent) ? { percent, status } : null;
  } catch {
    return null;
  }
}

async function readDisk(path = "/"): Promise<{ totalBytes: number; freeBytes: number } | null> {
  try {
    const stats = await statfs(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

export class SystemStatusAdapter implements CapabilityAdapter {
  readonly family = "system_status" as const;
  isAvailable(): boolean { return true; }
  tools(): RegisteredTool[] {
    return [{
      name: "system.get_status",
      description: "Return the laptop's battery (percent and charging status), CPU load, memory and disk.",
      inputSchema,
      permission: "read",
      family: this.family,
      enabled: true,
      handler: async () => ({
        hostname: hostname(),
        platform: platform(),
        release: release(),
        uptimeSeconds: uptime(),
        battery: await readBattery(),
        cpu: { count: cpus().length, loadAverage1m: loadavg()[0] },
        memory: { totalBytes: totalmem(), freeBytes: freemem() },
        disk: await readDisk(),
      }),
    }];
  }
}
