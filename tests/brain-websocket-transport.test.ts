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

  it("schedules reconnection with jittered backoff on disconnect and cancels cleanly on close", async () => {
    const transport = new BrainWebSocketTransport({
      url: "ws://unused",
      deviceId: "ganglion-test",
      token: "test",
      autoReconnect: true,
    });
    const internals = transport as unknown as {
      currentBackoffMs: number;
      reconnectTimer?: ReturnType<typeof setTimeout>;
      scheduleReconnect: () => void;
      stopReconnect: () => void;
      closedManually: boolean;
    };

    expect(internals.currentBackoffMs).toBe(1000);
    expect(internals.reconnectTimer).toBeUndefined();

    internals.scheduleReconnect();
    expect(internals.reconnectTimer).toBeDefined();
    // Base backoff increases by 1.5x up to max 10000ms
    expect(internals.currentBackoffMs).toBe(1500);

    // Manual close stops the reconnect timer and marks closedManually
    await transport.close();
    expect(internals.reconnectTimer).toBeUndefined();
    expect(internals.closedManually).toBe(true);
  });
});

describe("BrainWebSocketTransport when Brain refuses it", () => {
  it("keeps running and schedules a retry instead of rejecting start()", async () => {
    const { WebSocketServer } = await import("ws");
    const { createWelcomeAck, encode: enc, parse: parseEnvelope } = await import("@miobots/protocol");
    const server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    server.on("connection", (socket) => {
      socket.on("message", (data) => {
        const hello = parseEnvelope(data.toString());
        if (!hello.success) return;
        socket.send(enc(createWelcomeAck(hello.data, { accepted: false, seq: 1, reason: "Ganglion device is not allowlisted" })));
        socket.close();
      });
    });

    const transport = new BrainWebSocketTransport({ url: `ws://127.0.0.1:${port}`, deviceId: "ganglion-test", token: "test" });
    await transport.start();
    const internals = transport as unknown as { reconnectTimer?: ReturnType<typeof setTimeout> };
    for (let i = 0; i < 50 && !internals.reconnectTimer; i++) await new Promise((r) => setTimeout(r, 20));
    expect(internals.reconnectTimer).toBeDefined();

    await transport.close();
    server.close();
  });
});

describe("BrainWebSocketTransport across a Brain restart", () => {
  it("keeps the MCP server answering after the socket drops and reconnects", async () => {
    const { WebSocketServer } = await import("ws");
    const { createWelcomeAck, encode: enc, Kind, newEnvelope, parse: parseEnvelope, SequenceCounter } = await import("@miobots/protocol");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");

    let connections = 0;
    const answers: unknown[] = [];
    const server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    server.on("connection", (socket) => {
      const attempt = ++connections;
      const seq = new SequenceCounter();
      socket.on("message", (data) => {
        const envelope = parseEnvelope(data.toString());
        if (!envelope.success) return;
        if (envelope.data.topic === Topics.SYS_HELLO) {
          socket.send(enc(createWelcomeAck(envelope.data, { accepted: true, seq: seq.next() })));
          // The first Brain "restarts" right after welcoming us; the second one asks for initialize.
          if (attempt === 1) setTimeout(() => socket.close(), 20);
          else socket.send(enc(newEnvelope({
            kind: Kind.CMD, topic: Topics.MCP_REQUEST, seq, idem_key: "init-2",
            payload: { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "brain", version: "1" } } } as never,
          })));
        }
        if (envelope.data.topic === Topics.MCP_RESPONSE) answers.push(envelope.data.payload);
      });
    });

    const transport = new BrainWebSocketTransport({ url: `ws://127.0.0.1:${port}`, deviceId: "ganglion-test", token: "test" });
    const mcp = new McpServer({ name: "ganglion-test", version: "1" });
    await mcp.connect(transport);

    for (let i = 0; i < 300 && answers.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(connections).toBeGreaterThanOrEqual(2);
    expect(answers[0]).toMatchObject({ id: 0, result: { serverInfo: { name: "ganglion-test" } } });

    await transport.close();
    server.close();
  }, 15_000);
});
