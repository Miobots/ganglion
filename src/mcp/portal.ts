
import { MessageBus, Variant, sessionBus } from "dbus-next";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const PORTAL_DESTINATION = "org.freedesktop.portal.Desktop";
const PORTAL_PATH = "/org/freedesktop/portal/desktop";
const SCREENSHOT_INTERFACE = "org.freedesktop.portal.Screenshot";
const REQUEST_INTERFACE = "org.freedesktop.portal.Request";

const RESPONSE_TIMEOUT_MS = 30_000;

interface ScreenshotResponse {
  bytes: Buffer;
  mimeType: string;
}

interface PortalResponse {
  response: number;
  results: Record<string, unknown>;
}

interface ScreenshotPortalOptions {
  interactive?: boolean;
}

export class ScreenshotPortal {
  private bus: MessageBus | undefined;

  async capture(
    options: ScreenshotPortalOptions = {},
  ): Promise<ScreenshotResponse> {
    const bus = sessionBus();
    this.bus = bus;

    try {
      const object = await bus.getProxyObject(
        PORTAL_DESTINATION,
        PORTAL_PATH,
      );

      const screenshot = object.getInterface(SCREENSHOT_INTERFACE) as unknown as {
        Screenshot(
          parentWindow: string,
          options: Record<string, Variant>,
        ): Promise<string>;
      };

      const handleToken = `ganglion_${process.pid}_${Date.now()}`;

      const requestHandle = await screenshot.Screenshot("", {
        handle_token: new Variant("s", handleToken),
        interactive: new Variant("b", options.interactive ?? true),
      });

      const response = await this.waitForResponse(bus, requestHandle);

      if (response.response !== 0) {
        throw new Error(
          response.response === 1
            ? "Screenshot was cancelled by the user"
            : "Screenshot portal failed",
        );
      }

const uriValue = response.results.uri;

const uri =
  uriValue instanceof Variant
    ? uriValue.value
    : uriValue;

if (typeof uri !== "string" || !uri.startsWith("file://")) {
  throw new Error("Screenshot portal returned an invalid file URI");
}
      const filePath = fileURLToPath(uri);
      const bytes = await readFile(filePath);

      if (bytes.length === 0) {
        throw new Error("Screenshot portal returned an empty image");
      }

      return {
        bytes,
        mimeType: this.detectMimeType(bytes),
      };
    } finally {
      bus.disconnect();
      this.bus = undefined;
    }
  }

  private async waitForResponse(
    bus: MessageBus,
    requestHandle: string,
  ): Promise<PortalResponse> {
    const requestObject = await bus.getProxyObject(
      PORTAL_DESTINATION,
      requestHandle,
    );

    const request = requestObject.getInterface(REQUEST_INTERFACE) as {
      on(
        event: "Response",
        callback: (response: number, results: Record<string, unknown>) => void,
      ): void;
      removeAllListeners(event: "Response"): void;
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        request.removeAllListeners("Response");
        reject(new Error("Screenshot portal response timed out"));
      }, RESPONSE_TIMEOUT_MS);

      request.on("Response", (response, results) => {
        clearTimeout(timeout);
        request.removeAllListeners("Response");
        resolve({ response, results });
      });
    });
  }

  private detectMimeType(bytes: Buffer): string {
    if (
      bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      )
    ) {
      return "image/png";
    }

    if (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    ) {
      return "image/jpeg";
    }

    if (
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    ) {
      return "image/webp";
    }

    throw new Error("Screenshot has an unsupported image format");
  }
}
