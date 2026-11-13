import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport, TransportSendOptions } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { GanglionTransport } from "./types.ts";

/** Adapts the Phase 2 Brain WebSocket adapter to the official MCP SDK Transport contract. */
export class InjectedMcpTransport implements Transport {
  sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly injected: GanglionTransport;

  constructor(injected: GanglionTransport) {
    this.injected = injected;
    this.injected.onmessage = (message) => this.onmessage?.(message);
    this.injected.onerror = (error) => this.onerror?.(error);
    this.injected.onclose = () => this.onclose?.();
  }

  async start(): Promise<void> { await this.injected.start(); }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    await this.injected.send(message);
  }

  async close(): Promise<void> {
    await this.injected.close();
    this.onclose?.();
  }
}
