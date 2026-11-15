import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { GanglionMcpServer } from "../src/mcp/server.ts";
import { createGanglionMcpServer } from "../src/mcp/bootstrap.ts";
import { DefaultPermissionManager } from "../src/mcp/permissions.ts";
import { DefaultToolRegistry } from "../src/mcp/registry.ts";
import { InMemoryAuditLog, SecureFilesystem } from "../src/mcp/filesystem/secure-filesystem.ts";
import { parseFilesystemPolicy } from "../src/mcp/filesystem/policy.ts";
import { filesystemTools } from "../src/mcp/tools/filesystem.ts";
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
    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const filesystem = new SecureFilesystem(policy, audit);
    await filesystem.initialize(policy);
    expect((await filesystem.list(approved)).entries).toEqual(expect.arrayContaining([{ name: "existing.txt", type: "file" }]));
    await expect(filesystem.readFile(join(approved, "escape", "secret.txt"))).rejects.toThrow(/outside approved/);
    await expect(filesystem.readFile(join(approved, "..", "outside", "secret.txt"))).rejects.toThrow(/outside approved/);
    await writeFile(join(approved, "link-target.txt"), "preserve me");
    await symlink(join(approved, "link-target.txt"), join(approved, "link.txt"));
    await expect(filesystem.delete(join(approved, "link.txt"), false, true)).rejects.toThrow(/symbolic links/);
    await expect(filesystem.delete("link.txt", false, true)).rejects.toThrow(/symbolic links/);
    expect(await readFile(join(approved, "link-target.txt"), "utf8")).toBe("preserve me");
    await expect(filesystem.createFile(join(approved, "existing.txt"), "new")).rejects.toThrow(/overwrite/);
    await expect(filesystem.delete(join(approved, "existing.txt"), false, false)).rejects.toThrow(/approval/);
    await filesystem.createFile(join(approved, "new.txt"), "new");
    expect(await readFile(join(approved, "new.txt"), "utf8")).toBe("new");
    await filesystem.createDirectory(join(approved, "folder"));
    await filesystem.rename(join(approved, "new.txt"), join(approved, "renamed.txt"));
    await filesystem.move(join(approved, "renamed.txt"), join(approved, "folder", "moved.txt"));
    expect(await filesystem.inspect(join(approved, "folder", "moved.txt"))).toMatchObject({ isDirectory: false, sizeBytes: 3 });
    await filesystem.delete(join(approved, "folder", "moved.txt"), false, true);
    expect(audit.entries().map((entry) => entry.operation)).toContain("write_file");
    expect(audit.entries().map((entry) => entry.operation)).toEqual(expect.arrayContaining(["create_directory", "move", "delete"]));
  });

  it("registers the filesystem tool API", () => {
    const names = filesystemTools({} as SecureFilesystem).map((tool) => tool.name);
    expect(names).toEqual([
      "filesystem.list",
      "filesystem.search",
      "filesystem.get_info",
      "filesystem.read_file",
      "filesystem.create_directory",
      "filesystem.write_file",
      "filesystem.move",
      "filesystem.copy",
      "filesystem.delete",
    ]);
  });

  it("lists the sole approved root when the tool is called without arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-default-list-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    const policy = { approvedDirectories: [{ path: approved, allowWrite: false }] };
    const filesystem = new SecureFilesystem(policy, new InMemoryAuditLog());
    await filesystem.initialize(policy);
    const listTool = filesystemTools(filesystem).find((tool) => tool.name === "filesystem.list");

    expect(listTool?.inputSchema).toMatchObject({ required: [] });
    await expect(listTool?.handler({})).resolves.toMatchObject({ path: ".", entries: [] });
    await expect(listTool?.handler({ path: "" })).resolves.toMatchObject({ path: ".", entries: [] });
  });

  it("defaults directory reads and anchors relative paths to the sole approved root", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-root-relative-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    await writeFile(join(root, "outside.txt"), "outside");
    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const filesystem = new SecureFilesystem(policy, new InMemoryAuditLog());
    await filesystem.initialize(policy);
    const tools = filesystemTools(filesystem);
    const getInfoTool = tools.find((tool) => tool.name === "filesystem.get_info");
    const searchTool = tools.find((tool) => tool.name === "filesystem.search");
    const writeTool = tools.find((tool) => tool.name === "filesystem.write_file");
    const mkdirTool = tools.find((tool) => tool.name === "filesystem.create_directory");

    await expect(getInfoTool?.handler({ path: "" })).resolves.toMatchObject({ path: ".", isDirectory: true });
    await expect(searchTool?.handler({ path: "", query: "needle", includeContent: false })).resolves.toMatchObject({ path: ".", matches: [] });
    await mkdirTool?.handler({ path: "folder" });
    await writeTool?.handler({ path: "folder/note.txt", content: "needle" });
    expect(await readFile(join(approved, "folder", "note.txt"), "utf8")).toBe("needle");
    await expect(searchTool?.handler({ query: "needle", includeContent: true })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "folder/note.txt", matchType: "content" })],
    });
    await expect(filesystem.readFile("../outside.txt")).rejects.toThrow(/outside approved/);

    const registry = new DefaultToolRegistry(new DefaultPermissionManager({
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async () => true,
    }));
    for (const tool of tools.filter((item) => item.permission === "action")) registry.register(tool);
    await registry.execute("filesystem.copy", { source: "folder/note.txt", destination: "folder/copy.txt" });
    expect(await readFile(join(approved, "folder", "copy.txt"), "utf8")).toBe("needle");
    await registry.execute("filesystem.move", { source: "folder/copy.txt", destination: "folder/moved.txt" });
    await registry.execute("filesystem.delete", { path: "folder/moved.txt", confirmed: true });
    await expect(readFile(join(approved, "folder", "moved.txt"), "utf8")).rejects.toThrow();
  });

  it("requires a path for pathless listing when multiple roots are configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-multiple-roots-"));
    const first = join(root, "first");
    const second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    const policy = { approvedDirectories: [
      { path: first, allowWrite: false },
      { path: second, allowWrite: false },
    ] };
    const filesystem = new SecureFilesystem(policy, new InMemoryAuditLog());
    await filesystem.initialize(policy);
    await expect(filesystem.list()).rejects.toThrow(/path is required/);
  });

  it("validates opt-in filesystem policy configuration", () => {
    expect(parseFilesystemPolicy()).toBeUndefined();
    expect(parseFilesystemPolicy(JSON.stringify({ approvedDirectories: [{ path: "/tmp/work", allowWrite: false }] })))
      .toEqual({ approvedDirectories: [{ path: "/tmp/work", allowWrite: false }] });
    expect(() => parseFilesystemPolicy("not-json")).toThrow(/valid JSON/);
    expect(() => parseFilesystemPolicy(JSON.stringify({ approvedDirectories: [{ path: "relative", allowWrite: true }] })))
      .toThrow(/absolute path/);
  });

  it("passes canonical targets into action approval requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-approval-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const filesystem = new SecureFilesystem(policy, new InMemoryAuditLog());
    await filesystem.initialize(policy);
    const writeTool = filesystemTools(filesystem).find((tool) => tool.name === "filesystem.write_file");
    await expect(writeTool?.approvalRequest?.({ path: join(approved, "new.txt"), content: "x" })).resolves.toMatchObject({
      target: join(approved, "new.txt"),
      reason: "Create file",
    });
    await expect(writeTool?.approvalRequest?.({ path: join(root, "outside.txt"), content: "x" })).rejects.toThrow(/outside approved/);

    let approvedTarget: string | undefined;
    const registry = new DefaultToolRegistry(new DefaultPermissionManager({
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async (request) => { approvedTarget = request.target; return true; },
    }));
    registry.register(writeTool!);
    await registry.execute("filesystem.write_file", { path: join(approved, "approved.txt"), content: "x" });
    expect(approvedTarget).toBe(join(approved, "approved.txt"));
  });

  it("searches approved paths by name and text and supports metadata and file operations", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-search-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    const policy = { approvedDirectories: [{ path: approved, allowWrite: true }] };
    const filesystem = new SecureFilesystem(policy, new InMemoryAuditLog());
    await filesystem.initialize(policy);
    const directory = join(approved, "reports");
    await filesystem.createDirectory(directory);
    const file = join(directory, "weekly.txt");
    await filesystem.writeFile(file, "first line\nNeedle found here\nlast line");

    const nameMatches = await filesystem.search(approved, "weekly", false);
    expect(nameMatches.matches).toContainEqual({ path: "reports/weekly.txt", matchType: "name" });
    expect((await filesystem.search(approved, "reports/weekly", false)).matches).toContainEqual({
      path: "reports/weekly.txt",
      matchType: "name",
    });
    const contentMatches = await filesystem.search(approved, "needle");
    expect(contentMatches.matches).toContainEqual({
      path: "reports/weekly.txt",
      matchType: "content",
      lineNumber: 2,
      excerpt: "Needle found here",
    });
    expect(await filesystem.readFile(file)).toMatchObject({ content: "first line\nNeedle found here\nlast line" });
    expect(await filesystem.getInfo(file)).toMatchObject({ isDirectory: false });

    const copied = join(directory, "copy.txt");
    await filesystem.copy(file, copied);
    expect(await readFile(copied, "utf8")).toContain("Needle");
    const copiedDirectory = join(approved, "reports-copy");
    await filesystem.copy(directory, copiedDirectory);
    expect(await readFile(join(copiedDirectory, "weekly.txt"), "utf8")).toContain("Needle");
    const moved = join(directory, "moved.txt");
    await filesystem.move(copied, moved);
    await expect(filesystem.readFile(copied)).rejects.toThrow(/does not exist/);
    await filesystem.delete(moved, false, true);
    await expect(filesystem.copy(file, file)).rejects.toThrow(/overwrite/);
    await filesystem.writeFile(file, "updated", true);
    expect(await readFile(file, "utf8")).toBe("updated");
  });

  it("bounds reads and writes and requires confirmation for recursive deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-limits-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    const policy = {
      approvedDirectories: [{ path: approved, allowWrite: true }],
      limits: { maxReadBytes: 4, maxWriteBytes: 4, maxSearchResults: 1 },
    };
    const filesystem = new SecureFilesystem(policy, new InMemoryAuditLog());
    await filesystem.initialize(policy);
    await expect(filesystem.writeFile(join(approved, "too-large.txt"), "12345")).rejects.toThrow(/write limit/);
    await writeFile(join(approved, "large.txt"), "12345");
    await expect(filesystem.readFile(join(approved, "large.txt"))).rejects.toThrow(/read limit/);

    await writeFile(join(approved, "needle-one.txt"), "x");
    await writeFile(join(approved, "needle-two.txt"), "x");
    const results = await filesystem.search(approved, "needle", false);
    expect(results.matches).toHaveLength(1);
    expect(results.truncated).toBe(true);

    const nested = join(approved, "nested");
    await filesystem.createDirectory(nested);
    await filesystem.writeFile(join(nested, "child.txt"), "x");
    await expect(filesystem.delete(nested, true, false)).rejects.toThrow(/confirmation/);
    await filesystem.delete(nested, true, true);
    await expect(filesystem.delete(approved, true, true)).rejects.toThrow(/approved directory root/);
  });

  it("registers the seven capability families without advertising unavailable handlers", () => {
    const families = new Set(filesystemTools({} as SecureFilesystem).map((tool) => tool.family));
    expect(families).toEqual(new Set(["filesystem"]));
    expect(["screen_capture", "open_application_or_url", "media_control", "system_status", "confined_process", "autostart", "filesystem"]).toHaveLength(7);
  });

  it("bootstraps the implemented system-status adapter through injected transport", async () => {
    const [serverTransport, clientTransport] = pair();
    const server = await createGanglionMcpServer(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.start(), client.connect(clientTransport)]);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain("system.get_status");
    const result = await client.callTool({ name: "system.get_status", arguments: {} });
    expect(result.isError).not.toBe(true);
    await client.close();
    await server.close();
  });

  it("registers filesystem tools through its adapter when policy is configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-mcp-bootstrap-"));
    const approved = join(root, "approved");
    await mkdir(approved);
    const [serverTransport, clientTransport] = pair();
    const server = await createGanglionMcpServer(serverTransport, {
      filesystem: { approvedDirectories: [{ path: approved, allowWrite: true }] },
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.start(), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain("filesystem.search");
    expect(names).toContain("filesystem.copy");
    await client.close();
    await server.close();
  });

  it("rejects invalid nested schemas and unexpected properties before handlers run", async () => {
    const [serverTransport, clientTransport] = pair();
    let calls = 0;
    const server = new GanglionMcpServer(serverTransport, {
      tools: [{
        name: "test.rich_schema",
        description: "Validate rich input",
        inputSchema: {
          type: "object",
          required: ["mode", "items"],
          additionalProperties: false,
          properties: {
            mode: { type: "string", enum: ["safe", "fast"] },
            items: { type: "array", minItems: 1, items: { type: "object", required: ["count"], additionalProperties: false, properties: { count: { type: "number", minimum: 1 } } } },
          },
        },
        permission: "read",
        family: "system_status",
        enabled: true,
        handler: async () => { calls++; return { ok: true }; },
      }],
    });
    const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
    await Promise.all([server.start(), client.connect(clientTransport)]);
    expect((await client.callTool({ name: "test.rich_schema", arguments: { mode: "safe", items: [{ count: 2 }], extra: true } })).isError).toBe(true);
    expect((await client.callTool({ name: "test.rich_schema", arguments: { mode: "unsafe", items: [{ count: 2 }] } })).isError).toBe(true);
    expect((await client.callTool({ name: "test.rich_schema", arguments: { mode: "safe", items: [] } })).isError).toBe(true);
    expect(calls).toBe(0);
    await client.close();
    await server.close();
  });
});
