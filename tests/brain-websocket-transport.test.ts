import { describe, expect, it } from "bun:test";
import WebSocket from "ws";
import { decode, Topics } from "@miobots/protocol";
import { BrainWebSocketTransport } from "../src/mcp/brain-websocket-transport.ts";

describe("BrainWebSocketTransport", () => {
  it("returns a correlated error when an MCP result exceeds the wire limit", async () => {
    const sent: string[] = [];
    const transport = new BrainWebSocketTransport({ url: "ws://unused", deviceId: "ganglion-test", token: "test" });
    const internals = transport as unknown as { socket: WebSocket; pendingCorrelations: Map<string, string> };
    internals.socket = { readyState: WebSocket.OPEN, send: (wire: string) => sent.push(wire) } as unknown as WebSocket;
    internals.pendingCorrelations.set("1", "request-1");
    internals.pendingCorrelations.set("2", "request-2");

    await transport.send({ jsonrpc: "2.0", id: "1", result: { content: [{ type: "text", text: "a".repeat(600_000) }] } });
    await transport.send({ jsonrpc: "2.0", id: "2", result: { content: [{ type: "text", text: "ok" }] } });

    const first = decode(sent[0]!);
    const second = decode(sent[1]!);
    expect(first.topic).toBe(Topics.MCP_RESPONSE);
    expect(first.corr_id).toBe("request-1");
    expect(first.payload).toMatchObject({ id: "1", result: { isError: true, content: [{ type: "text", text: expect.stringContaining("result_too_large") }] } });
    expect(second.seq).toBe(first.seq + 1);
    expect(second.payload).toMatchObject({ id: "2", result: { content: [{ type: "text", text: "ok" }] } });
  });
});
