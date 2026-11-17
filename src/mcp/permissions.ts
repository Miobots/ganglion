import type { ApprovalProvider, PermissionDecision, PermissionManager, RegisteredTool, ApprovalRequest, ToolContext } from "./types.ts";

export class DefaultPermissionManager implements PermissionManager {
  private readonly approval?: ApprovalProvider;

  constructor(approval?: ApprovalProvider) { this.approval = approval; }

  async authorize(tool: RegisteredTool, request: ApprovalRequest, _context?: ToolContext): Promise<PermissionDecision> {
    if (!tool.enabled) return { allowed: false, code: "disabled_tool", message: "Tool is disabled" };
    if (tool.permission === "read") return { allowed: true, code: "allowed", message: "Read operation permitted" };
    if (!this.approval || !this.approval.isTrusted() || this.approval.isVoiceApproval()) {
      return { allowed: false, code: "approval_required", message: "Trusted approval is required" };
    }
    const approved = await this.approval.requestApproval(request);
    return approved
      ? { allowed: true, code: "allowed", message: "Action approved" }
      : { allowed: false, code: "approval_rejected", message: "Action was not approved" };
  }
}
