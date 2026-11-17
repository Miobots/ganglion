import { spawn } from "node:child_process";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";
import { McpToolError } from "../types.ts";

export interface RegisteredAppOrUrl {
  name: string;
  type: "app" | "url";
  target: string;
  args?: string[];
}

export interface AppLauncherPolicy {
  allowedTargets: RegisteredAppOrUrl[];
}

export interface AppLauncherOptions {
  policy: AppLauncherPolicy;
  launcher?: (entry: RegisteredAppOrUrl) => Promise<void>;
  platform?: NodeJS.Platform;
}

export function parseAppLauncherPolicy(raw?: string): AppLauncherPolicy | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw);
    const targets = Array.isArray(parsed) ? parsed : parsed.allowedTargets;
    if (!Array.isArray(targets)) throw new Error("allowedTargets must be an array");
    const allowedTargets: RegisteredAppOrUrl[] = targets.map((item: any) => {
      if (typeof item !== "object" || item === null) throw new Error("Target item must be an object");
      if (typeof item.name !== "string" || !item.name.trim()) throw new Error("Target name must be a string");
      if (item.type !== "app" && item.type !== "url") throw new Error("Target type must be 'app' or 'url'");
      if (typeof item.target !== "string" || !item.target.trim()) throw new Error("Target target must be a string");
      if (item.type === "url" && !item.target.startsWith("http://") && !item.target.startsWith("https://")) {
        throw new Error("URL target must begin with http:// or https://");
      }
      return {
        name: item.name.trim(),
        type: item.type,
        target: item.target.trim(),
        ...(Array.isArray(item.args) ? { args: item.args.map(String) } : {}),
      };
    });
    return { allowedTargets };
  } catch (error) {
    throw new Error(`Invalid GANGLION_APP_ALLOWLIST policy: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const INPUT_SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description: "Identifier of the pre-registered application or website to open.",
    },
  },
  required: ["name"],
  additionalProperties: false,
};

export class AppLauncherAdapter implements CapabilityAdapter {
  readonly family = "open_application_or_url" as const;
  private readonly policy: AppLauncherPolicy;
  private readonly launcher: (entry: RegisteredAppOrUrl) => Promise<void>;
  private readonly platform: NodeJS.Platform;

  constructor(options: AppLauncherOptions) {
    this.policy = options.policy;
    this.platform = options.platform ?? process.platform;
    this.launcher = options.launcher ?? ((entry) => this.defaultLaunch(entry));
  }

  isAvailable(): boolean {
    return this.policy.allowedTargets.length > 0;
  }

  findTarget(name: string): RegisteredAppOrUrl | undefined {
    const normalized = name.trim().toLowerCase();
    return this.policy.allowedTargets.find((t) => t.name.toLowerCase() === normalized);
  }

  tools(): RegisteredTool[] {
    return [
      {
        name: "open_app_or_url",
        description: "Open a pre-registered application or URL on the desktop. Strictly restricted to human-approved registered targets and requires explicit user action approval.",
        inputSchema: INPUT_SCHEMA,
        permission: "action",
        family: this.family,
        enabled: true,
        approvalRequest: async (input: unknown) => {
          const name = (input as { name: string })?.name;
          if (!name || typeof name !== "string") {
            throw new McpToolError("invalid_arguments", "Target name is required");
          }
          const target = this.findTarget(name);
          if (!target) {
            throw new McpToolError("unregistered_target", `Target '${name}' is not in the registered allow-list`);
          }
          return {
            target: target.target,
            reason: `Open registered ${target.type} '${target.name}' (${target.target})`,
          };
        },
        handler: async (input: unknown) => {
          const name = (input as { name: string })?.name;
          if (!name || typeof name !== "string") {
            throw new McpToolError("invalid_arguments", "Target name is required");
          }
          const target = this.findTarget(name);
          if (!target) {
            throw new McpToolError("unregistered_target", `Target '${name}' is not in the registered allow-list`);
          }
          await this.launcher(target);
          return {
            status: "opened",
            name: target.name,
            type: target.type,
            target: target.target,
          };
        },
      },
    ];
  }

  private async defaultLaunch(entry: RegisteredAppOrUrl): Promise<void> {
    if (entry.type === "url") {
      if (!entry.target.startsWith("http://") && !entry.target.startsWith("https://")) {
        throw new McpToolError("invalid_target", "Only HTTP and HTTPS URLs are permitted");
      }
      if (this.platform === "linux") {
        const child = spawn("xdg-open", [entry.target], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (this.platform === "darwin") {
        const child = spawn("open", [entry.target], { detached: true, stdio: "ignore" });
        child.unref();
      } else if (this.platform === "win32") {
        const child = spawn("cmd.exe", ["/c", "start", '""', entry.target], { detached: true, stdio: "ignore" });
        child.unref();
      }
      return;
    }

    if (entry.type === "app") {
      // Trigger pre-registered executable without shell interpretation
      const child = spawn(entry.target, entry.args ?? [], {
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }
  }
}
