import type { CapabilityAdapter, RegisteredTool } from "../types.ts";
import { ScreenshotPortal } from "../portal.ts";

export class ScreenCaptureAdapter implements CapabilityAdapter {
  readonly family = "screen_capture" as const;
  private readonly portal = new ScreenshotPortal();

  isAvailable(): boolean {
    return process.platform === "linux" && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
  }

  tools(): RegisteredTool[] {
    return [{
      name: "screen.get_screenshot",
      description: "Capture a screenshot of the user's current desktop. The desktop portal may display a consent prompt.",
      inputSchema: {
        type: "object",
        properties: { interactive: { type: "boolean", description: "Whether to allow the desktop portal to show its interactive capture UI." } },
        required: [],
        additionalProperties: false,
      },
      permission: "read",
      family: this.family,
      enabled: true,
      handler: async (input: unknown) => {
        const screenshot = await this.portal.capture({ interactive: (input as { interactive?: boolean }).interactive });
        return { type: "image", mimeType: screenshot.mimeType, data: screenshot.bytes.toString("base64"), sizeBytes: screenshot.bytes.length };
      },
    }];
  }
}