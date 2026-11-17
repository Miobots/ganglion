import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InjectedMcpTransport } from "./sdk-transport.ts";
import { DefaultToolRegistry } from "./registry.ts";
import { DefaultPermissionManager } from "./permissions.ts";
import type { ApprovalProvider, CapabilityAdapter, GanglionTransport, RegisteredTool, ToolSchema } from "./types.ts";

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
  private readonly validators = new Map<string, z.ZodTypeAny>();
  private readonly lifecycleAdapters: CapabilityAdapter[] = [];
  private readonly startedAdapters: CapabilityAdapter[] = [];
  private started = false;
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
      if (!adapter.isAvailable()) continue;
      this.lifecycleAdapters.push(adapter);
      for (const tool of adapter.tools()) this.register(tool);
    }
    this.transport = new InjectedMcpTransport(transport);
  }

  register(tool: RegisteredTool): void {
    this.registry.register(tool);
    if (!tool.enabled) return;
    const validator = this.zodInputSchema(tool.inputSchema);
    this.validators.set(tool.name, validator);
    this.server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: validator,
_meta: {
  ...(tool.metadata ?? {}),
  "miobots/permission": tool.permission,
},
    }, async (input: unknown, extra: { signal?: AbortSignal }) => {
      try {
        const parsed = this.validators.get(tool.name)?.safeParse(input);
        if (!parsed?.success) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: JSON.stringify({ code: "invalid_arguments", message: "Tool arguments are invalid" }) }],
          };
        }
        const result = await this.registry.execute(
  tool.name,
  parsed.data,
  { signal: extra.signal },
);

if (this.isImageResult(result)) {
  // Base64 expands image data by approximately 4/3.
  // Keep a conservative limit because Protocol envelopes
  // have a 64 KB maximum message size.
  const MAX_INLINE_IMAGE_BYTES = 350 * 1024;

  if (result.sizeBytes > MAX_INLINE_IMAGE_BYTES) {
    return {
      isError: true,
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          code: "image_too_large",
          message:
            "Screenshot exceeds the current inline image limit. " +
            "Image resizing or artifact transfer is required.",
          sizeBytes: result.sizeBytes,
          maxBytes: MAX_INLINE_IMAGE_BYTES,
        }),
      }],
    };
  }

  return {
    content: [{
      type: "image" as const,
      data: result.data,
      mimeType: result.mimeType,
    }],
  };
}

return {
  content: [{
    type: "text" as const,
    text: JSON.stringify(result),
  }],
};
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
    if (this.started) return;
    await this.server.connect(this.transport);
    try {
      for (const adapter of this.lifecycleAdapters) {
        await adapter.start?.();
        this.startedAdapters.push(adapter);
      }
      this.started = true;
    } catch (error) {
      try {
        await this.stopAdapters();
      } catch {
        // Preserve the startup failure while still closing the MCP server.
      }
      this.closed = true;
      await this.server.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    let adapterError: unknown;
    try {
      await this.stopAdapters();
    } catch (error) {
      adapterError = error;
    }
    await this.server.close();
    if (adapterError !== undefined) throw adapterError;
  }

  private async stopAdapters(): Promise<void> {
    const adapters = this.startedAdapters.splice(0).reverse();
    const outcomes = await Promise.allSettled(adapters.map((adapter) => adapter.stop?.()));
    const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    if (failure) throw failure.reason;
  }

  private zodInputSchema(schema: ToolSchema): z.ZodTypeAny {
    if (typeof schema === "string") throw new Error("Tool schema must describe an object");
    if (!("type" in schema)) {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, property] of Object.entries(schema)) shape[key] = this.zodValue(property as ToolSchema);
      return z.object(shape).strict();
    }
    if (schema.type !== "object") throw new Error("Tool input schema must be an object");
    const shape: Record<string, z.ZodType> = {};
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      let value = this.zodValue(property);
      if (!(schema.required ?? []).includes(key)) value = value.optional();
      shape[key] = value;
    }
    return z.object(shape).strict();
  }

  private zodValue(schema: ToolSchema): z.ZodTypeAny {
    if (typeof schema === "string") {
      if (schema === "string") return z.string();
      if (schema === "number") return z.number().finite();
      if (schema === "boolean") return z.boolean();
      throw new Error("Unsupported schema declaration");
    }
    let value: z.ZodTypeAny;
    if (schema.type === "object") {
      const shape: Record<string, z.ZodType> = {};
      for (const [key, property] of Object.entries(schema.properties ?? {})) {
        let nested = this.zodValue(property);
        if (!(schema.required ?? []).includes(key)) nested = nested.optional();
        shape[key] = nested;
      }
      value = schema.additionalProperties === false ? z.object(shape).strict() : z.object(shape);
    } else if (schema.type === "array") {
      let arrayValue = z.array(this.zodValue(schema.items));
      if (schema.minItems !== undefined) arrayValue = arrayValue.min(schema.minItems);
      if (schema.maxItems !== undefined) arrayValue = arrayValue.max(schema.maxItems);
      value = arrayValue;
    } else if (schema.type === "string") {
      let stringValue: z.ZodTypeAny = schema.enum?.length ? z.enum(schema.enum as [string, ...string[]]) : z.string();
      if (schema.minLength !== undefined) stringValue = (stringValue as z.ZodString).min(schema.minLength);
      if (schema.maxLength !== undefined) stringValue = (stringValue as z.ZodString).max(schema.maxLength);
      value = stringValue;
    } else if (schema.type === "number") {
      let numberValue: z.ZodTypeAny = z.number().finite();
      if (schema.minimum !== undefined) numberValue = (numberValue as z.ZodNumber).min(schema.minimum);
      if (schema.maximum !== undefined) numberValue = (numberValue as z.ZodNumber).max(schema.maximum);
      value = numberValue;
    } else {
      value = z.boolean();
    }
    return value;
  }
  private isImageResult(
  result: unknown,
): result is {
  type: "image";
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  data: string;
  sizeBytes: number;
} {
  if (typeof result !== "object" || result === null) {
    return false;
  }

  const value = result as Record<string, unknown>;

  return (
    value.type === "image" &&
    ["image/png", "image/jpeg", "image/webp"].includes(
      value.mimeType as string,
    ) &&
    typeof value.data === "string" &&
    typeof value.sizeBytes === "number"
  );
}

  private safeError(error: unknown): { code: string; message: string } {
    if (error instanceof Error && error.message.length < 256) {
      const code = "code" in error && typeof error.code === "string" ? error.code : "handler_error";
      return { code, message: error.message };
    }
    return { code: "handler_error", message: "Tool execution failed" };
  }
}
