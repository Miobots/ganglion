import { createHash } from "node:crypto";
import { canonicalJson, isApprovalTicket } from "@miobots/protocol";
import type { ApprovalProvider, PermissionDecision, PermissionManager, RegisteredTool, ApprovalRequest, ToolContext } from "./types.ts";

/** Ticket ids already spent. Bounded: a ticket lives 30 s, so old ids can never be replayed anyway. */
const USED_TICKET_LIMIT = 1000;

export class DefaultPermissionManager implements PermissionManager {
  private readonly approval?: ApprovalProvider;
  private readonly usedTickets = new Set<string>();
  private readonly now: () => number;

  constructor(approval?: ApprovalProvider, now: () => number = Date.now) {
    this.approval = approval;
    this.now = now;
  }

  async authorize(tool: RegisteredTool, request: ApprovalRequest, context?: ToolContext): Promise<PermissionDecision> {
    if (!tool.enabled) return { allowed: false, code: "disabled_tool", message: "Tool is disabled" };
    if (tool.permission === "read") return { allowed: true, code: "allowed", message: "Read operation permitted" };

    // A human tapped Approve on the phone for exactly this call (BRAIN_DECISIONS 27).
    if (context?.approval !== undefined) return this.checkTicket(tool, context);

    if (!this.approval || !this.approval.isTrusted() || this.approval.isVoiceApproval()) {
      return { allowed: false, code: "approval_required", message: "Trusted approval is required" };
    }
    const approved = await this.approval.requestApproval(request);
    return approved
      ? { allowed: true, code: "allowed", message: "Action approved" }
      : { allowed: false, code: "approval_rejected", message: "Action was not approved" };
  }

  private checkTicket(tool: RegisteredTool, context: ToolContext): PermissionDecision {
    const ticket = context.approval;
    const refuse = (message: string): PermissionDecision => {
      console.warn(`[Ganglion] Refused ${tool.name}: ${message}`);
      return { allowed: false, code: "untrusted_approval", message };
    };
    if (!isApprovalTicket(ticket)) return refuse("The approval ticket is malformed");
    if (ticket.tool !== tool.name) return refuse("The approval was for a different tool");
    const digest = createHash("sha256").update(canonicalJson(context.rawInput ?? {})).digest("hex");
    if (digest !== ticket.args_sha256) return refuse("The arguments differ from the ones approved");
    if (this.now() >= ticket.expires_at) return refuse("The approval has expired");
    if (this.usedTickets.has(ticket.approval_id)) return refuse("The approval was already used");
    this.usedTickets.add(ticket.approval_id);
    if (this.usedTickets.size > USED_TICKET_LIMIT) this.usedTickets.delete(this.usedTickets.values().next().value!);
    console.log(`[Ganglion] ${tool.name} approved on the phone by ${ticket.approved_by} (approval ${ticket.approval_id})`);
    return { allowed: true, code: "allowed", message: `Approved by ${ticket.approved_by}` };
  }
}
