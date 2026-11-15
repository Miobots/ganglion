import { McpToolError, type PermissionManager, type RegisteredTool, type ToolContext, type ToolRegistry } from "./types.ts";

export class DefaultToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly permissions: PermissionManager;

  constructor(permissions: PermissionManager) { this.permissions = permissions; }

  register<Input>(tool: RegisteredTool<Input>): void {
    if (!/^[a-z0-9._-]+$/.test(tool.name) || tool.name.length > 128) {
      throw new Error("Tool name is invalid");
    }
    if (this.tools.has(tool.name)) throw new Error(`Tool '${tool.name}' is already registered`);
    this.tools.set(tool.name, tool as RegisteredTool);
  }

  get(name: string): RegisteredTool | undefined { return this.tools.get(name); }

  listEnabled(): RegisteredTool[] { return [...this.tools.values()].filter((tool) => tool.enabled); }

  async execute(name: string, input: unknown, context: ToolContext = {}): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new McpToolError("unknown_tool", "Unknown tool");
    const approvalDetails = await tool.approvalRequest?.(input);
    const decision = await this.permissions.authorize(tool, {
      toolName: name,
      tier: "action",
      target: approvalDetails?.target,
      reason: approvalDetails?.reason ?? `MCP requested ${name}`,
    }, context);
    if (!decision.allowed) throw new McpToolError(decision.code, decision.message);
    return tool.handler(input, context);
  }
}
