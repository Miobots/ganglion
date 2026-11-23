import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { createAck, createWelcomeAck, encode, Kind, newEnvelope, parse, SequenceCounter, Topics, type ApprovalPayload } from "@miobots/protocol";
import { approvalBody, createDesktopApprovalSurface, type Notifications } from "../src/mcp/desktop-approval.ts";
import { BrainWebSocketTransport } from "../src/mcp/brain-websocket-transport.ts";

const request: ApprovalPayload = { approval_id: "ap-1", tool_name: "run_script", args: { id: "backup" }, expires_at: Date.now() + 60_000 };

function fakeNotifications(click?: string) {
  const events = new EventEmitter();
  const shown: { summary: string; body: string; actions: string[] }[] = [];
  const notifications = {
    Notify: async (_app: string, _r: number, _i: string, summary: string, body: string, actions: string[]) => {
      shown.push({ summary, body, actions });
      if (click) setTimeout(() => events.emit("ActionInvoked", 7, click), 5);
      return 7;
    },
    CloseNotification: async () => {},
    on: (event: string, listener: (...args: never[]) => void) => events.on(event, listener),
    off: (event: string, listener: (...args: never[]) => void) => events.off(event, listener),
  } as unknown as Notifications;
  return { notifications, shown, events };
}

describe("desktop approval surface (G2.3)", () => {
  it("shows the exact arguments with Approve and Reject, and returns the click", async () => {
    const approve = fakeNotifications("approve");
    expect(await createDesktopApprovalSurface(async () => approve.notifications)(request)).toBe(true);
    expect(approve.shown[0]).toEqual({ summary: "Mio wants to use this laptop", body: 'run_script\nid: "backup"', actions: ["approve", "Approve", "reject", "Reject"] });
    const reject = fakeNotifications("reject");
    expect(await createDesktopApprovalSurface(async () => reject.notifications)(request)).toBe(false);
  });

  it("treats a dismissed notification as no answer, not as a no", async () => {
    const dismissed = fakeNotifications();
    const answer = createDesktopApprovalSurface(async () => dismissed.notifications)(request);
    setTimeout(() => dismissed.events.emit("NotificationClosed", 7, 2), 5);
    expect(await answer).toBeUndefined();
    expect(approvalBody({ ...request, args: { b: 1, a: "x" } })).toBe('run_script\na: "x"\nb: 1');
  });

  it("offers itself in the hello and answers sys.approval on the same connection", async () => {
    const { WebSocketServer } = await import("ws");
    const server = new WebSocketServer({ port: 0 });
    const port = (server.address() as { port: number }).port;
    let hello: unknown;
    const answers: unknown[] = [];
    server.on("connection", (socket) => {
      const seq = new SequenceCounter();
      socket.on("message", (data) => {
        const envelope = parse(data.toString());
        if (!envelope.success) return;
        if (envelope.data.topic === Topics.SYS_HELLO) {
          hello = envelope.data.payload;
          socket.send(encode(createWelcomeAck(envelope.data, { accepted: true, seq: seq.next() })));
          socket.send(encode(newEnvelope({ kind: Kind.CMD, topic: Topics.SYS_APPROVAL, seq, idem_key: "approval-ap-1", expires_at: request.expires_at, payload: request })));
        }
        if (envelope.data.kind === Kind.ACK) answers.push(envelope.data.payload);
      });
    });
    const transport = new BrainWebSocketTransport({ url: `ws://127.0.0.1:${port}`, deviceId: "g", token: "t", approvalSurface: async () => false });
    await transport.start();
    for (let i = 0; i < 100 && answers.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hello).toMatchObject({ capabilities: ["desktop-approval"] });
    expect(answers).toEqual([{ accepted: false, reason: "Rejected on the laptop." }]);
    await transport.close();
    server.close();
  });
});
