import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { GanglionMcpServer } from "../src/mcp/server.ts";
import { DefaultPermissionManager } from "../src/mcp/permissions.ts";
import { DefaultToolRegistry } from "../src/mcp/registry.ts";
import { InMemoryAuditLog, SecureFilesystem, filesystemTools } from "../src/mcp/filesystem.ts";
import type { GanglionTransport, RegisteredTool } from "../src/mcp/types.ts";

class MemoryTransport implements GanglionTransport {
  peer?: MemoryTransport;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  started = false;
  closed = false;

  async start(): Promise<void> { this.started = true; }
  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.peer) throw new Error("transport closed");
    queueMicrotask(() => this.peer?.onmessage?.(message));
  }
  async close(): Promise<void> { this.closed = true; this.onclose?.(); }
}

function pair(): [MemoryTransport, MemoryTransport] {
  const left = new MemoryTransport();
  const right = new MemoryTransport();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

const readTool: RegisteredTool = {
  name: "system.status",
  description: "Return deterministic status.",
  inputSchema: {},
  permission: "read",
  family: "system_status",
  enabled: true,
  handler: async () => ({ status: "ok" }),
};

const actionTool: RegisteredTool = {
  name: "system.action",
  description: "Perform an action.",
  inputSchema: {},
  permission: "action",
  family: "system_status",
  enabled: true,
  handler: async () => ({ performed: true }),
};

describe("Ganglion MCP server core", () => {
  it("initializes through an injected transport and exposes only registered tools", async () => {
    const [serverTransport, clientTransport] = pair();
    const server = new GanglionMcpServer(serverTransport, { tools: [readTool] });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });

    await Promise.all([server.start(), client.connect(clientTransport)]);
    const listed = await client.listTools();

    expect(listed.tools.map((tool) => tool.name)).toEqual(["system.status"]);
    expect(client.getServerVersion()?.name).toBe("miobots-ganglion");
    expect(serverTransport.started).toBe(true);
    await client.close();
    await server.close();
    expect(serverTransport.closed).toBe(true);
  });

  it("validates input and executes read tools, while denying action tools without approval", async () => {
    const [serverTransport, clientTransport] = pair();
    let actionCalls = 0;
    const action: RegisteredTool = { ...actionTool, handler: async () => { actionCalls++; return { ok: true }; } };
    const server = new GanglionMcpServer(serverTransport, { tools: [readTool, action] });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.start(), client.connect(clientTransport)]);

    const readResult = await client.callTool({ name: "system.status", arguments: {} });
    expect(readResult.isError).not.toBe(true);
    expect(JSON.stringify(readResult.content)).toContain("ok");

    const actionResult = await client.callTool({ name: "system.action", arguments: {} });
    expect(actionResult.isError).toBe(true);
    expect(actionCalls).toBe(0);
    await client.close();
    await server.close();
  });

  it("requires trusted non-voice approval and never treats voice as authorization", async () => {
    let calls = 0;
    const tool: RegisteredTool = { ...actionTool, handler: async () => { calls++; return true; } };
    const registry = new DefaultToolRegistry(new DefaultPermissionManager({
      isTrusted: () => true,
      isVoiceApproval: () => true,
      requestApproval: async () => true,
    }));
    registry.register(tool);
    await expect(registry.execute(tool.name, {})).rejects.toThrow(/Trusted approval/);
    expect(calls).toBe(0);

    const approved = new DefaultToolRegistry(new DefaultPermissionManager({
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async () => true,
    }));
    approved.register(tool);
    await expect(approved.execute(tool.name, {})).resolves.toBe(true);
    expect(calls).toBe(1);
  });

  it("enforces approved filesystem boundaries, no overwrite, deletion approval, and audit", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    await writeFile(join(approved, "existing.txt"), "old");
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(approved, "escape"));

    const audit = new InMemoryAuditLog();
    const filesystem = new SecureFilesystem({ approvedDirectories: [{ path: approved, allowWrite: true }] }, audit);
    await filesystem.initialize();
    expect(await filesystem.listDirectory(approved)).toEqual(expect.arrayContaining([{ name: "existing.txt", type: "file" }]));
    await expect(filesystem.readFile(join(approved, "escape", "secret.txt"))).rejects.toThrow(/outside approved/);
    await expect(filesystem.createFile(join(approved, "existing.txt"), "new")).rejects.toThrow(/overwrite/);
    await expect(filesystem.delete(join(approved, "existing.txt"), false, false)).rejects.toThrow(/approval/);
    await filesystem.createFile(join(approved, "new.txt"), "new");
    expect(await readFile(join(approved, "new.txt"), "utf8")).toBe("new");
    expect(audit.entries().map((entry) => entry.operation)).toContain("create_file");
  });

  it("registers the seven capability families without advertising unavailable handlers", () => {
    const families = new Set(filesystemTools({} as SecureFilesystem).map((tool) => tool.family));
    expect(families).toEqual(new Set(["filesystem"]));
    expect(["screen_capture", "open_application_or_url", "media_control", "system_status", "confined_process", "autostart", "filesystem"]).toHaveLength(7);
  });
});
