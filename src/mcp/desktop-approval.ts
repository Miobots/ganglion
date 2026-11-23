import { sessionBus, Variant, type MessageBus } from "dbus-next";
import type { ApprovalPayload } from "@miobots/protocol";

/**
 * The laptop as a second approval surface (G2.3, GANGLION_DECISIONS 12–13, 34).
 *
 * A desktop notification shows the tool and the exact arguments with Approve and Reject buttons;
 * the click is sent back as the ACK to Brain's `sys.approval`, on the connection it arrived on. The
 * phone is asked at the same time and the first answer wins. Voice still never approves: this is a
 * click on the logged-in desktop, the same kind of surface as the phone's card.
 *
 * Off unless the human turns it on (`desktopApprovals` in config.json, or the settings window).
 */

/** true = Approve, false = Reject, undefined = no answer before it expired. */
export type ApprovalSurface = (request: ApprovalPayload) => Promise<boolean | undefined>;

/** The part of org.freedesktop.Notifications this needs; injected in tests. */
export interface Notifications {
  Notify(appName: string, replacesId: number, icon: string, summary: string, body: string, actions: string[], hints: Record<string, Variant>, timeoutMs: number): Promise<number>;
  CloseNotification(id: number): Promise<void>;
  on(event: "ActionInvoked", listener: (id: number, action: string) => void): void;
  on(event: "NotificationClosed", listener: (id: number, reason: number) => void): void;
  off(event: string, listener: (...args: never[]) => void): void;
}

/** Exactly what will run: one line per argument, each value as the JSON the tool receives. */
export function approvalBody(request: ApprovalPayload): string {
  const args = Object.keys(request.args).sort().map((key) => `${key}: ${JSON.stringify(request.args[key])}`);
  return [request.tool_name, ...args].join("\n");
}

export function createDesktopApprovalSurface(connect: () => Promise<Notifications> = connectNotifications): ApprovalSurface {
  return async (request) => {
    const notifications = await connect();
    const remainingMs = Math.max(1_000, request.expires_at - Date.now());
    const id = await notifications.Notify(
      "MioBots", 0, "dialog-question",
      "Mio wants to use this laptop",
      approvalBody(request),
      ["approve", "Approve", "reject", "Reject"],
      { urgency: new Variant("y", 2), "desktop-entry": new Variant("s", "miobots-ganglion") },
      0,
    );
    return new Promise<boolean | undefined>((resolve) => {
      const finish = (answer: boolean | undefined) => {
        clearTimeout(timer);
        notifications.off("ActionInvoked", onAction as never);
        notifications.off("NotificationClosed", onClosed as never);
        resolve(answer);
      };
      const onAction = (shown: number, action: string) => {
        if (shown !== id) return;
        void notifications.CloseNotification(id).catch(() => undefined);
        finish(action === "approve" ? true : action === "reject" ? false : undefined);
      };
      // Dismissing it is not a no; the request stays open on the phone.
      const onClosed = (shown: number) => { if (shown === id) finish(undefined); };
      const timer = setTimeout(() => {
        void notifications.CloseNotification(id).catch(() => undefined);
        finish(undefined);
      }, remainingMs);
      notifications.on("ActionInvoked", onAction);
      notifications.on("NotificationClosed", onClosed);
    });
  };
}

let bus: MessageBus | undefined;

async function connectNotifications(): Promise<Notifications> {
  bus ??= sessionBus();
  const object = await bus.getProxyObject("org.freedesktop.Notifications", "/org/freedesktop/Notifications");
  return object.getInterface("org.freedesktop.Notifications") as unknown as Notifications;
}
