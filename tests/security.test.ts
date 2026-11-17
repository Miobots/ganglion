import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { SecureFilesystem, InMemoryAuditLog } from "../src/mcp/filesystem/secure-filesystem.ts";
import { createGanglionMcpServer } from "../src/mcp/bootstrap.ts";
import type { GanglionTransport } from "../src/mcp/types.ts";

class MemoryTransport implements GanglionTransport {
  peer?: MemoryTransport;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  started = false;

  async start(): Promise<void> { this.started = true; }
  async send(message: JSONRPCMessage): Promise<void> {
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }
  async close(): Promise<void> { this.started = false; this.onclose?.(); }
}

function pair(): [MemoryTransport, MemoryTransport] {
  const server = new MemoryTransport();
  const client = new MemoryTransport();
  server.peer = client;
  client.peer = server;
  return [server, client];
}

describe("Task G1.5 - Path Traversal Vulnerability Test Suite", () => {
  it("refuses relative path climbing out (../../etc/passwd)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-security-relative-"));
    const approved = join(root, "approved");
    await mkdir(approved, { recursive: true });
    await writeFile(join(approved, "valid.txt"), "hello approved");

    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const fs = new SecureFilesystem(policy, new InMemoryAuditLog());
    await fs.initialize(policy);

    // 1. Path climbing out using relative traversal to an existing file (/etc/passwd)
    const climbToPasswd = join(approved, "../../../../../../../../../../etc/passwd");
    await expect(fs.readFile(climbToPasswd)).rejects.toThrow(/outside approved/);
    await expect(fs.getInfo(climbToPasswd)).rejects.toThrow(/outside approved/);

    // Relative traversal climbing out to any other non-approved path is refused
    await expect(fs.readFile("../../etc/passwd")).rejects.toThrow();
    await expect(fs.getInfo("../../etc/passwd")).rejects.toThrow();
    await expect(fs.list("../../")).rejects.toThrow(/outside approved/);

    await rm(root, { recursive: true, force: true });
  });

  it("refuses plain absolute paths outside approved roots (/etc/passwd)", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-security-absolute-"));
    const approved = join(root, "approved");
    await mkdir(approved, { recursive: true });

    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const fs = new SecureFilesystem(policy, new InMemoryAuditLog());
    await fs.initialize(policy);

    // 2. Direct absolute path outside approved folder
    await expect(fs.readFile("/etc/passwd")).rejects.toThrow(/outside approved/);
    await expect(fs.getInfo("/etc/hosts")).rejects.toThrow(/outside approved/);
    await expect(fs.list("/var/log")).rejects.toThrow(/outside approved/);
    await expect(fs.writeFile("/tmp/evil.txt", "escape")).rejects.toThrow(/outside approved/);

    await rm(root, { recursive: true, force: true });
  });

  it("refuses symlinks inside the approved folder pointing outside to /etc", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-security-symlink-"));
    const approved = join(root, "approved");
    await mkdir(approved, { recursive: true });

    // 3. Symlink inside approved folder pointing to /etc
    const symlinkPath = join(approved, "etc_symlink");
    try {
      await symlink("/etc", symlinkPath);
    } catch {
      // If symlink creation fails due to platform restrictions, test passes
      return;
    }

    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const fs = new SecureFilesystem(policy, new InMemoryAuditLog());
    await fs.initialize(policy);

    // Canonical symlink resolution must catch the escape before reading
    await expect(fs.readFile(join(symlinkPath, "passwd"))).rejects.toThrow(/outside approved/);
    await expect(fs.getInfo(join(symlinkPath, "passwd"))).rejects.toThrow(/outside approved/);
    await expect(fs.list(symlinkPath)).rejects.toThrow(/outside approved/);

    await rm(root, { recursive: true, force: true });
  });

  it("enforces path traversal prevention through end-to-end MCP tool calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-security-mcp-"));
    const approved = join(root, "approved");
    await mkdir(approved, { recursive: true });
    await writeFile(join(approved, "safe.txt"), "safe content");

    const symlinkPath = join(approved, "escape_link");
    try {
      await symlink("/etc", symlinkPath);
    } catch {
      // Continue if symlink fails
    }

    const policy = { approvedDirectories: [{ path: approved, allowWrite: false }] };
    const [serverTransport, clientTransport] = pair();
    const server = await createGanglionMcpServer(serverTransport, { filesystem: policy });
    const client = new Client({ name: "security-auditor", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.start(), client.connect(clientTransport)]);

    // Call 1: relative traversal escape climbing out to /etc/passwd
    const relResult = await client.callTool({
      name: "filesystem.read_file",
      arguments: { path: join(approved, "../../../../../../../../../../etc/passwd") },
    });
    expect(relResult.isError).toBe(true);
    expect(JSON.stringify(relResult.content)).toContain("outside approved");

    // Call 2: absolute path escape
    const absResult = await client.callTool({
      name: "filesystem.read_file",
      arguments: { path: "/etc/passwd" },
    });
    expect(absResult.isError).toBe(true);
    expect(JSON.stringify(absResult.content)).toContain("outside approved");

    // Call 3: symlink escape
    const linkResult = await client.callTool({
      name: "filesystem.read_file",
      arguments: { path: join(approved, "escape_link", "passwd") },
    });
    expect(linkResult.isError).toBe(true);
    expect(JSON.stringify(linkResult.content)).toContain("outside approved");

    // Call 4: Safe file inside approved directory works
    const safeResult = await client.callTool({
      name: "filesystem.read_file",
      arguments: { path: "safe.txt" },
    });
    expect(safeResult.isError).toBeUndefined();
    expect(JSON.stringify(safeResult.content)).toContain("safe content");

    await server.close();
    await rm(root, { recursive: true, force: true });
  });
});
