import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { parseTiers } from "../src/tiers.ts";
import { ConnectorAdapter, parseConnectors, simplifySchema } from "../src/mcp/adapters/connectors.ts";
import { GanglionMcpServer } from "../src/mcp/server.ts";
import type { GanglionTransport } from "../src/mcp/types.ts";

const idle = { start: async () => {}, send: async () => {}, close: async () => {} } as unknown as GanglionTransport;

describe("per-tool tiers (G6.1)", () => {
  it("accepts one tool per key and refuses anything blanket", () => {
    expect(parseTiers({ "open_app_or_url": "read", "media_control": "action" })).toEqual({ open_app_or_url: "read", media_control: "action" });
    expect(() => parseTiers({ "*": "read" })).toThrow("no wildcards");
    expect(() => parseTiers({ "all tools": "read" })).toThrow("no wildcards");
    expect(() => parseTiers({ media_control: "auto" })).toThrow('"read" or "action"');
  });

  it("changes the tier a tool is registered and advertised with", () => {
    const tool = { name: "demo.tool", description: "d", inputSchema: { type: "object" as const, properties: {} }, permission: "action" as const, family: "connector" as const, enabled: true, handler: async () => "ok" };
    const server = new GanglionMcpServer(idle, { tools: [tool], tiers: { "demo.tool": "read" } });
    expect(server.registry.get("demo.tool")?.permission).toBe("read");
    expect(server.registry.get("demo.tool")?.metadata).toEqual({ "miobots/default_permission": "action" });
  });
});

describe("connectors a human added (G6.2)", () => {
  it("validates the list", () => {
    expect(parseConnectors([{ name: "notes", command: "notes-mcp", args: ["--ro"] }])).toEqual([{ name: "notes", command: "notes-mcp", args: ["--ro"] }]);
    expect(() => parseConnectors([{ name: "Bad Name", command: "x" }])).toThrow("lowercase");
    expect(() => parseConnectors([{ name: "a", command: "x" }, { name: "a", command: "y" }])).toThrow("twice");
  });

  it("reduces a JSON schema to what Ganglion checks, dropping what it can't", () => {
    expect(simplifySchema({ type: "object", properties: { n: { type: "integer" }, tags: { type: "array", items: { type: "string" } }, odd: { anyOf: [] } }, required: ["n", "odd"] }))
      .toEqual({ type: "object", properties: { n: { type: "number" }, tags: { type: "array", items: { type: "string" } } }, required: ["n"], additionalProperties: false });
  });

  it("starts a real stdio MCP server, gives its tools the strictest tier, and calls through", async () => {
    const adapter = await ConnectorAdapter.connect({ name: "echo", command: process.execPath, args: [join(import.meta.dir, "fixtures/echo-connector.ts")] });
    const [tool] = adapter.tools();
    expect(tool).toMatchObject({ name: "echo.echo_text", permission: "action", family: "connector" });
    expect(tool!.description).toContain('connector "echo", added by a human');
    expect(await tool!.handler({ text: "ab", times: 2 }, {})).toMatchObject({ content: [{ type: "text", text: "abab" }] });
    await adapter.stop();
  }, 20_000);
});
