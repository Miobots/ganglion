
import WebSocket, { type RawData } from "ws";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  createAck,
  DeviceRole,
  encode,
  Kind,
  newEnvelope,
  parse,
  ProtocolDefaults,
  ProtocolError,
  ProtocolErrorCode,
  SequenceCounter,
  SystemHealth,
  Topics,
} from "@miobots/protocol";
import type { GanglionTransport } from "./types.ts";

interface BrainTransportOptions {
  url: string;
  deviceId: string;
  token: string;
}

type StartupCallbacks = {
  resolve: () => void;
  reject: (error: Error) => void;
};

export class BrainWebSocketTransport implements GanglionTransport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  private socket?: WebSocket;
  private readonly sequence = new SequenceCounter();
  private readonly pendingCorrelations = new Map<string, string>();
  private readonly options: BrainTransportOptions;
  private helloCorrelation?: string;
  private startup?: StartupCallbacks;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(options: BrainTransportOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      this.startup = { resolve, reject };

      const timeout = setTimeout(() => {
        reject(new Error("Timed out waiting for Brain authentication"));
        socket.close();
      }, 10_000);

      socket.on("open", () => {
        const hello = newEnvelope({
          kind: Kind.CMD,
          topic: Topics.SYS_HELLO,
          seq: this.sequence,
          payload: {
            device_id: this.options.deviceId,
            token: this.options.token,
            protocol_version: ProtocolDefaults.PROTOCOL_VERSION,
            role: DeviceRole.GANGLION,
          },
        });

        this.helloCorrelation = hello.corr_id;
        socket.send(encode(hello));
        console.log("[Ganglion] Sent authentication hello to Brain");
      });

      socket.on("message", (data: RawData) => {
        try {
          this.handleMessage(data);
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error));
          this.onerror?.(normalized);
          if (this.startup) {
            clearTimeout(timeout);
            this.startup.reject(normalized);
            this.startup = undefined;
          }
        }
      });

      socket.on("error", (error) => {
        clearTimeout(timeout);
        this.onerror?.(error);

        if (this.startup) {
          this.startup.reject(error);
          this.startup = undefined;
        }
      });

      socket.on("close", () => {
        this.stopHeartbeat();
        this.started = false;
        this.onclose?.();
        console.log("[Ganglion] Brain connection closed");
      });

      const originalResolve = resolve;
      this.startup = {
        resolve: () => {
          clearTimeout(timeout);
          originalResolve();
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("Ganglion is not connected to Brain");
    }

    // MCP server responses must use the correlation ID of the
    // original Brain -> Ganglion Protocol command.
    if (
      "id" in message &&
      ("result" in message || "error" in message)
    ) {
      const rpcId = String(message.id);
      const correlationId = this.pendingCorrelations.get(rpcId);

      if (!correlationId) {
        throw new Error(`Missing Protocol correlation for MCP response ${rpcId}`);
      }

      const envelope = newEnvelope({
        kind: Kind.EVT,
        topic: Topics.MCP_RESPONSE,
        corr_id: correlationId,
        seq: this.sequence,
        payload: message as never,
      });

      let wire: string;
      try {
        wire = encode(envelope);
      } catch (error) {
        if (!(error instanceof ProtocolError) || error.code !== ProtocolErrorCode.ERR_PAYLOAD_TOO_LARGE) throw error;
        wire = encode(newEnvelope({
          kind: Kind.EVT,
          topic: Topics.MCP_RESPONSE,
          corr_id: correlationId,
          seq: envelope.seq,
          payload: {
            jsonrpc: "2.0",
            id: rpcId,
            result: {
              isError: true,
              content: [{ type: "text", text: JSON.stringify({ code: "result_too_large", message: "MCP result exceeds the wire limit" }) }],
            },
          },
        }));
      }
      socket.send(wire);
      this.pendingCorrelations.delete(rpcId);
      return;
    }

    // MCP server notifications, e.g. tools/list_changed.
    if ("method" in message && !("id" in message)) {
      const envelope = newEnvelope({
        kind: Kind.EVT,
        topic: Topics.MCP_NOTIFICATION,
        seq: this.sequence,
        payload: message as never,
      });

      socket.send(encode(envelope));
      return;
    }

    throw new Error("Unexpected MCP server-to-client message");
  }

  async close(): Promise<void> {
    this.stopHeartbeat();
    this.pendingCorrelations.clear();

    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      this.socket.close();
    }
  }

  private handleMessage(data: RawData): void {
    const raw = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);

    const parsed = parse(raw);

    if (!parsed.success) {
      throw new Error(`Invalid Brain Protocol envelope: ${parsed.error.message}`);
    }

    const envelope = parsed.data;

    // Complete the initial sys.hello / sys.welcome handshake.
    if (
      envelope.kind === Kind.ACK &&
      envelope.topic === Topics.SYS_WELCOME &&
      envelope.corr_id === this.helloCorrelation
    ) {
      const welcome = envelope.payload as { accepted?: boolean; reason?: string };

      if (!welcome.accepted) {
        throw new Error(`Brain rejected Ganglion: ${welcome.reason ?? "unknown reason"}`);
      }

      this.started = true;
      this.startHeartbeat();
      console.log("[Ganglion] Authenticated with Brain");

      this.startup?.resolve();
      this.startup = undefined;
      return;
    }

    // Brain heartbeat: no response is required.
    if (
      envelope.kind === Kind.EVT &&
      envelope.topic === Topics.SYS_HEARTBEAT
    ) {
      return;
    }

    // Brain sends MCP requests as Protocol CMD envelopes.
    if (
      envelope.kind === Kind.CMD &&
      envelope.topic === Topics.MCP_REQUEST
    ) {
      const message = envelope.payload as JSONRPCMessage;

      if (!("id" in message)) {
        throw new Error("MCP request is missing its JSON-RPC id");
      }

      this.pendingCorrelations.set(String(message.id), envelope.corr_id);
      this.acknowledge(envelope);
      this.onmessage?.(message);
      return;
    }

    // Brain sends MCP notifications as Protocol CMD envelopes too.
    if (
      envelope.kind === Kind.CMD &&
      envelope.topic === Topics.MCP_NOTIFICATION
    ) {
      this.acknowledge(envelope);
      this.onmessage?.(envelope.payload as JSONRPCMessage);
      return;
    }
  }

  private acknowledge(envelope: Parameters<typeof createAck>[0]): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const ack = createAck(
      envelope,
      { accepted: true },
      this.sequence,
    );

    this.socket.send(encode(ack));
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

      const heartbeat = newEnvelope({
        kind: Kind.EVT,
        topic: Topics.SYS_HEARTBEAT,
        seq: this.sequence,
        payload: {
          status: SystemHealth.OK,
          t_wall_ms: Date.now(),
        },
      });

      this.socket.send(encode(heartbeat));
    }, ProtocolDefaults.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}
