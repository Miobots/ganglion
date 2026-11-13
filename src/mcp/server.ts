import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InjectedMcpTransport } from "./sdk-transport.ts";
import { DefaultToolRegistry } from "./registry.ts";
import { DefaultPermissionManager } from "./permissions.ts";
import type { ApprovalProvider, CapabilityAdapter, GanglionTransport, RegisteredTool } from "./types.ts";

export interface GanglionMcpServerOptions {
  name?: string;
  version?: string;
  approvalProvider?: ApprovalProvider;
  tools?: RegisteredTool[];
  adapters?: CapabilityAdapter[];
}

export class GanglionMcpServer {
  readonly server: McpServer;
  readonly registry: DefaultToolRegistry;
  private readonly transport: InjectedMcpTransport;
  private closed = false;

  constructor(transport: GanglionTransport, options: GanglionMcpServerOptions = {}) {
    this.server = new McpServer({
      name: options.name ?? "miobots-ganglion",
      version: options.version ?? "0.1.0",
    }, {
      maxToolInputElements: 256,
    });
    this.registry = new DefaultToolRegistry(new DefaultPermissionManager(options.approvalProvider));
    for (const tool of options.tools ?? []) this.register(tool);
    for (const adapter of options.adapters ?? []) {
      if (adapter.isAvailable()) for (const tool of adapter.tools()) this.register(tool);
    }
    this.transport = new InjectedMcpTransport(transport);
  }

  register(tool: RegisteredTool): void {
    this.registry.register(tool);
    if (!tool.enabled) return;
    this.server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: this.zodInputSchema(tool.inputSchema),
      _meta: tool.metadata,
    }, async (input: unknown, extra: { signal?: AbortSignal }) => {
      try {
        const result = await this.registry.execute(tool.name, input, { signal: extra.signal });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
      } catch (error) {
        const detail = this.safeError(error);
        return {
          isError: true,
          content: [{ type: "text" as const, text: JSON.stringify(detail) }],
        };
      }
    });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Ganglion MCP server is closed");
    await this.server.connect(this.transport);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close();
  }

  private zodInputSchema(schema: unknown): Record<string, z.ZodType> {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Tool schema must be an object");
    const shape: Record<string, z.ZodType> = {};
    for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
      if (value === "string") shape[key] = z.string();
      else if (value === "boolean") shape[key] = z.boolean();
      else if (value === "number") shape[key] = z.number().finite();
      else throw new Error(`Unsupported schema declaration for '${key}'`);
    }
    return shape;
  }

  private safeError(error: unknown): { code: string; message: string } {
    if (error instanceof Error && error.message.length < 256) {
      const code = "code" in error && typeof error.code === "string" ? error.code : "handler_error";
      return { code, message: error.message };
    }
    return { code: "handler_error", message: "Tool execution failed" };
  }
}
