import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type PermissionTier = "read" | "action";
export type CapabilityFamily =
  | "screen_capture"
  | "open_application_or_url"
  | "media_control"
  | "system_status"
  | "confined_process"
  | "autostart"
  | "filesystem";

export interface ToolContext {
  signal?: AbortSignal;
}

export type ToolSchema =
  | string
  | {
      type: "object";
      properties?: Record<string, ToolSchema>;
      required?: string[];
      additionalProperties?: boolean;
      description?: string;
    }
  | {
      type: "array";
      items: ToolSchema;
      minItems?: number;
      maxItems?: number;
      description?: string;
    }
  | {
      type: "string";
      enum?: string[];
      minLength?: number;
      maxLength?: number;
      description?: string;
    }
  | {
      type: "number";
      minimum?: number;
      maximum?: number;
      description?: string;
    }
  | {
      type: "boolean";
      description?: string;
    };

export interface RegisteredTool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  permission: PermissionTier;
  family: CapabilityFamily;
  enabled: boolean;
  metadata?: Record<string, unknown>;
  approvalRequest?: (input: unknown) => Promise<{ target?: string; reason?: string }>;
  handler: (input: Input, context: ToolContext) => Promise<unknown>;
}

export interface ApprovalRequest {
  toolName: string;
  tier: "action";
  target?: string;
  reason: string;
}

export interface ApprovalProvider {
  requestApproval(request: ApprovalRequest): Promise<boolean>;
  isTrusted(): boolean;
  isVoiceApproval(): boolean;
}

export interface PermissionDecision {
  allowed: boolean;
  code: "allowed" | "unknown_tool" | "disabled_tool" | "approval_required" | "approval_rejected" | "untrusted_approval";
  message: string;
}

export interface PermissionManager {
  authorize(tool: RegisteredTool, request: ApprovalRequest, context?: ToolContext): Promise<PermissionDecision>;
}

export class McpToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
  }
}

export interface ToolRegistry {
  register<Input>(tool: RegisteredTool<Input>): void;
  get(name: string): RegisteredTool | undefined;
  listEnabled(): RegisteredTool[];
  execute(name: string, input: unknown, context?: ToolContext): Promise<unknown>;
}

export interface GanglionTransport {
  send(message: JSONRPCMessage): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
}

export interface ApprovedDirectory {
  path: string;
  allowWrite: boolean;
}

export interface FilesystemPolicy {
  approvedDirectories: ApprovedDirectory[];
  limits?: Partial<FilesystemLimits>;
}

export interface FilesystemLimits {
  maxReadBytes: number;
  maxWriteBytes: number;
  maxSearchBytes: number;
  maxSearchResults: number;
  maxSearchDepth: number;
  maxDirectoryEntries: number;
  maxSearchEntries: number;
}

export interface AuditEntry {
  operation: string;
  target: string;
  timestamp: number;
}

export interface FilesystemAuditLog {
  record(entry: AuditEntry): void;
  entries(): readonly AuditEntry[];
}

export interface CapabilityAdapter {
  family: CapabilityFamily;
  isAvailable(): boolean;
  tools(): RegisteredTool[];
}
