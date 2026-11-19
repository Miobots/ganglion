import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { APPROVAL_META_KEY, canonicalJson, type ApprovalTicket } from "@miobots/protocol";
import { DefaultPermissionManager } from "../src/mcp/permissions.ts";
import { GanglionMcpServer } from "../src/mcp/server.ts";
import type { GanglionTransport, RegisteredTool } from "../src/mcp/types.ts";

const tool: RegisteredTool = {
  name: "open_app_or_url",
  description: "Open a registered target.",
  inputSchema: { type: "object", properties: { target: "string" }, required: ["target"] },
  permission: "action",
  family: "app_launcher",
  enabled: true,
  handler: async () => ({ opened: true }),
};
const request = { toolName: tool.name, tier: "action" as const, reason: "test" };
const digest = (args: unknown) => createHash("sha256").update(canonicalJson(args)).digest("hex");
const ticketFor = (args: unknown, overrides: Partial<ApprovalTicket> = {}): ApprovalTicket => ({
  approval_id: crypto.randomUUID(), approved_by: "synapse-app", tool: tool.name,
  args_sha256: digest(args), expires_at: Date.now() + 30_000, ...overrides,
});

describe("approval ticket check (BRAIN_DECISIONS 27)", () => {
  const manager = new DefaultPermissionManager();
  const authorize = (approval: unknown, rawInput: unknown) => manager.authorize(tool, request, { approval, rawInput });

  it("runs an action the phone approved, with exactly those arguments", async () => {
    const args = { target: "Spotify" };
    expect(await authorize(ticketFor(args), { target: "Spotify" })).toMatchObject({ allowed: true });
  });

  it("refuses changed arguments, another tool, an expired ticket, a reused ticket and a malformed one", async () => {
    expect((await authorize(ticketFor({ target: "Spotify" }), { target: "Terminal" })).allowed).toBe(false);
    expect((await authorize(ticketFor({ target: "a" }, { tool: "filesystem.delete" }), { target: "a" })).allowed).toBe(false);
    expect((await authorize(ticketFor({ target: "a" }, { expires_at: Date.now() - 1 }), { target: "a" })).allowed).toBe(false);
    const once = ticketFor({ target: "a" });
    expect((await authorize(once, { target: "a" })).allowed).toBe(true);
    expect((await authorize(once, { target: "a" })).allowed).toBe(false);
    expect((await authorize({ approved_by: "voice" }, { target: "a" })).allowed).toBe(false);
  });

  it("still refuses an action with no ticket and no trusted approver", async () => {
    expect(await new DefaultPermissionManager().authorize(tool, request, { rawInput: { target: "a" } })).toMatchObject({ allowed: false, code: "approval_required" });
  });
});

class MemoryTransport implements GanglionTransport {
  peer?: MemoryTransport;
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> { queueMicrotask(() => this.peer?.onmessage?.(message)); }
  async close(): Promise<void> { this.onclose?.(); }
}

describe("approval ticket over MCP", () => {
  it("runs the tool only when tools/call carries a matching ticket in _meta", async () => {
    const server = new MemoryTransport();
    const client = new MemoryTransport();
    server.peer = client;
    client.peer = server;
    let opened = 0;
    const ganglion = new GanglionMcpServer(server, { tools: [{ ...tool, handler: async () => { opened++; return { opened: true }; } }] });
    const brain = new Client({ name: "brain", version: "1" }, { capabilities: {} });
    await Promise.all([ganglion.start(), brain.connect(client)]);

    const args = { target: "Spotify" };
    expect((await brain.callTool({ name: tool.name, arguments: args })).isError).toBe(true);
    expect((await brain.callTool({ name: tool.name, arguments: args, _meta: { [APPROVAL_META_KEY]: ticketFor({ target: "Other" }) } })).isError).toBe(true);
    expect(opened).toBe(0);
    expect((await brain.callTool({ name: tool.name, arguments: args, _meta: { [APPROVAL_META_KEY]: ticketFor(args) } })).isError).not.toBe(true);
    expect(opened).toBe(1);
    await brain.close();
    await ganglion.close();
  });
});
