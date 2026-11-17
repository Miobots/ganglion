import type { CapabilityAdapter, FilesystemPolicy, RegisteredTool } from "../types.ts";
import { InMemoryAuditLog, SecureFilesystem } from "../filesystem/secure-filesystem.ts";
import { filesystemTools } from "../tools/filesystem.ts";

export class FilesystemAdapter implements CapabilityAdapter {
  readonly family = "filesystem" as const;
  readonly filesystem: SecureFilesystem;
  private readonly policy: FilesystemPolicy;

  constructor(policy: FilesystemPolicy, audit = new InMemoryAuditLog()) {
    this.policy = policy;
    this.filesystem = new SecureFilesystem(policy, audit);
  }

  async initialize(): Promise<void> {
    await this.filesystem.initialize(this.policy);
  }

  isAvailable(): boolean {
    return true;
  }

  tools(): RegisteredTool[] {
    return filesystemTools(this.filesystem);
  }
}