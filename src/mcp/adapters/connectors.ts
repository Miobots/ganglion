import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";
import type { ConnectorConfig } from "../../pairing.ts";

/**
 * Connectors a human added (G6.2, GANGLION_DECISIONS 11, 35): MCP servers listed in `config.json`
 * under `connectors`, started over stdio. Only the human can add one; no tool can write that file.
 *
 * **Every tool from a connector starts at the strictest tier, Action**: an unknown tool is not a
 * safe tool, so each call needs a tap until a human lowers that one tool in the settings window.
 * Tools are renamed `<connector>.<tool>` so they can never shadow a built-in.
 */

export interface ConnectorClient {
  listTools(): Promise<{ tools: { name: string; description?: string; inputSchema?: unknown }[] }>;
  callTool(request: { name: string; arguments?: Record<string, unknown> }): Promise<unknown>;
  close(): Promise<void>;
}

const PREFIX = /^[a-z][a-z0-9_-]{0,31}$/;

export function parseConnectors(value: unknown): ConnectorConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("connectors must be a list");
  const seen = new Set<string>();
  return value.map((item: Record<string, unknown>) => {
    if (typeof item?.name !== "string" || !PREFIX.test(item.name)) throw new Error(`connector name ${JSON.stringify(item?.name)}: lowercase letters, digits, - and _`);
    if (seen.has(item.name)) throw new Error(`connector ${item.name} is listed twice`);
    seen.add(item.name);
    if (typeof item.command !== "string" || !item.command) throw new Error(`connector ${item.name}: command is required`);
    if (item.args !== undefined && !(Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string"))) throw new Error(`connector ${item.name}: args must be strings`);
    return { name: item.name, command: item.command, ...(item.args ? { args: item.args as string[] } : {}) };
  });
}

/**
 * Reduces a connector's JSON Schema to what Ganglion validates. `integer` becomes `number`; a
 * property it cannot express is left out, so a call using it is refused rather than passed on
 * unchecked.
 */
export function simplifySchema(schema: unknown): ToolSchema {
  const value = (node: unknown): ToolSchema | undefined => {
    if (typeof node !== "object" || node === null) return undefined;
    const n = node as Record<string, unknown>;
    switch (n.type) {
      case "string":
        return Array.isArray(n.enum) && n.enum.every((e) => typeof e === "string") && n.enum.length
          ? { type: "string", enum: n.enum as string[] }
          : { type: "string" };
      case "number":
      case "integer":
        return { type: "number" };
      case "boolean":
        return { type: "boolean" };
      case "array": {
        const items = value(n.items);
        return items ? { type: "array", items } : undefined;
      }
      case "object":
        return object(n);
      default:
        return undefined;
    }
  };
  const object = (n: Record<string, unknown>): ToolSchema => {
    const properties: Record<string, ToolSchema> = {};
    for (const [key, property] of Object.entries((n.properties ?? {}) as Record<string, unknown>)) {
      const simplified = value(property);
      if (simplified) properties[key] = simplified;
    }
    const required = Array.isArray(n.required) ? (n.required as string[]).filter((key) => key in properties) : [];
    return { type: "object", properties, required, additionalProperties: false };
  };
  return object(typeof schema === "object" && schema !== null ? schema as Record<string, unknown> : {});
}

export class ConnectorAdapter implements CapabilityAdapter {
  readonly family = "connector" as const;
  private readonly config: ConnectorConfig;
  private readonly client: ConnectorClient;
  private readonly listed: { name: string; description?: string; inputSchema?: unknown }[];

  private constructor(config: ConnectorConfig, client: ConnectorClient, listed: ConnectorAdapter["listed"]) {
    this.config = config;
    this.client = client;
    this.listed = listed;
  }

  /** Starts the connector and lists its tools. Throws if it can't; the caller skips it. */
  static async connect(config: ConnectorConfig, open: (config: ConnectorConfig) => Promise<ConnectorClient> = openStdio): Promise<ConnectorAdapter> {
    const client = await open(config);
    const { tools } = await client.listTools();
    return new ConnectorAdapter(config, client, tools);
  }

  isAvailable(): boolean {
    return this.listed.length > 0;
  }

  async stop(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }

  tools(): RegisteredTool[] {
    return this.listed.flatMap((tool) => {
      const local = tool.name.toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 64);
      if (!local) return [];
      return [{
        name: `${this.config.name}.${local}`,
        description: `[connector "${this.config.name}", added by a human] ${tool.description ?? tool.name}`.slice(0, 1024),
        inputSchema: simplifySchema(tool.inputSchema),
        permission: "action" as const, // the strictest tier until a human lowers this one tool
        family: this.family,
        enabled: true,
        handler: async (input: unknown) => this.client.callTool({ name: tool.name, arguments: (input ?? {}) as Record<string, unknown> }),
      }];
    });
  }
}

async function openStdio(config: ConnectorConfig): Promise<ConnectorClient> {
  const client = new Client({ name: "miobots-ganglion", version: "0.1.0" });
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args ?? [], stderr: "inherit" }));
  return client as unknown as ConnectorClient;
}
