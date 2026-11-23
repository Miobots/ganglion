
import WebSocket, { type RawData } from "ws";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  createAck,
  DeviceRole,
  encode,
  isApprovalPayload,
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
import type { ApprovalSurface } from "./desktop-approval.ts";

export interface BrainTransportOptions {
  url: string;
  deviceId: string;
  token: string;
  autoReconnect?: boolean;
  /** Offer this laptop as an approval surface (G2.3); Brain then asks it alongside the phone. */
  approvalSurface?: ApprovalSurface;
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
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private currentBackoffMs: number = ProtocolDefaults.RECONNECT_INITIAL_DELAY_MS;
  private closedManually = false;
  private started = false;

  constructor(options: BrainTransportOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.closedManually = false;
    try {
      await this.connect();
    } catch (error) {
      // Brain being down or refusing us must never kill the daemon: say why, and keep retrying.
      // The socket's close handler has already scheduled the reconnect.
      if (this.options.autoReconnect === false) throw error;
      console.error(`[Ganglion] Could not connect to Brain: ${describeError(error)}. Retrying in the background.`);
    }
  }

  private connect(): Promise<void> {
    if (this.closedManually) return Promise.resolve();

    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      this.startup = { resolve, reject };

      const timeout = setTimeout(() => {
        const error = new Error("Timed out waiting for Brain authentication");
        if (this.startup) {
          this.startup.reject(error);
          this.startup = undefined;
        }
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
            ...(this.options.approvalSurface ? { capabilities: ["desktop-approval"] } : {}),
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
        clearTimeout(timeout);
        this.stopHeartbeat();
        this.pendingCorrelations.clear();
        this.started = false;
        console.log("[Ganglion] Brain connection closed");
        // Only a close that will not be retried ends the MCP session. The SDK detaches its server on
        // onclose for good, so reporting a drop we are about to reconnect from left the daemon
        // connected but unable to answer, and Brain's next initialize timed out.
        const reconnecting = !this.closedManually && (this.options.autoReconnect ?? true);
        if (!reconnecting) this.onclose?.();

        if (this.startup) {
          this.startup.reject(new Error("Connection closed before authentication"));
          this.startup = undefined;
        }

        if (!this.closedManually && (this.options.autoReconnect ?? true)) {
          this.scheduleReconnect();
        }
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
    this.closedManually = true;
    this.stopReconnect();
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
      this.currentBackoffMs = ProtocolDefaults.RECONNECT_INITIAL_DELAY_MS;
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

    // Brain asks for a human's answer (G2.3). The ACK is the click, sent on the connection the
    // request arrived on; no answer means no ACK, and Brain counts that as unanswered.
    if (envelope.kind === Kind.CMD && envelope.topic === Topics.SYS_APPROVAL && this.options.approvalSurface) {
      const socket = this.socket;
      if (!isApprovalPayload(envelope.payload)) return;
      void this.options.approvalSurface(envelope.payload).then((answer) => {
        if (answer === undefined || socket !== this.socket || socket?.readyState !== WebSocket.OPEN) return;
        socket.send(encode(createAck(envelope, answer ? { accepted: true } : { accepted: false, reason: "Rejected on the laptop." }, this.sequence)));
      }, (error: unknown) => console.warn(`[Ganglion] Desktop approval failed: ${describeError(error)}`));
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

  private scheduleReconnect(): void {
    if (this.closedManually || this.reconnectTimer) return;

    const min = this.currentBackoffMs * ProtocolDefaults.RECONNECT_JITTER_MIN_FACTOR;
    const max = this.currentBackoffMs * ProtocolDefaults.RECONNECT_JITTER_MAX_FACTOR;
    const delayMs = Math.round(min + Math.random() * (max - min));

    this.currentBackoffMs = Math.min(
      this.currentBackoffMs * ProtocolDefaults.RECONNECT_BACKOFF_MULTIPLIER,
      ProtocolDefaults.RECONNECT_MAX_DELAY_MS,
    );

    console.log(`[Ganglion] Scheduling reconnect to Brain in ${delayMs}ms (base: ${this.currentBackoffMs}ms)`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.closedManually) return;
      try {
        await this.connect();
      } catch (error) {
        console.log(`[Ganglion] Reconnection attempt failed: ${describeError(error)}`);
      }
    }, delayMs);

  }

  private stopReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}

/** Bun's WebSocket reports failures as an ErrorEvent, not an Error, and String() of it is useless. */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : String(error);
}
