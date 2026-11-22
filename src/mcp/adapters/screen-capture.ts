import { spawn } from "node:child_process";
import type { CapabilityAdapter, RegisteredTool } from "../types.ts";
import { McpToolError } from "../types.ts";
import { ScreenshotPortal } from "../portal.ts";

/**
 * `screen.get_screenshot` (G4.1) — Read tier, no tap (GANGLION_DECISIONS 6); Brain announces every
 * capture aloud before it runs (item 8, G4.2). GNOME asks once for consent and remembers it
 * (item 33). The image is shrunk to a JPEG that fits one protocol message (64 KB after base64).
 */

/** Largest raw image that still fits one 64 KB envelope once base64-encoded, with room to spare. */
export const MAX_WIRE_IMAGE_BYTES = 44_000;
/** Tried in order until one fits: width in pixels, ffmpeg JPEG quality (2 best … 31 worst). */
const LADDER: Array<[number, number]> = [[1280, 10], [1280, 16], [1024, 14], [800, 18], [640, 24]];

export type Shrink = (image: Buffer, width: number, quality: number) => Promise<Buffer>;

const ffmpegShrink: Shrink = (image, width, quality) => new Promise((resolve, reject) => {
  const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", `scale='min(${width},iw)':-2`, "-q:v", String(quality), "-f", "mjpeg", "pipe:1"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  child.on("error", (error) => reject(new McpToolError("shrink_unavailable", `Can't shrink the screenshot (is ffmpeg installed?): ${error.message}`)));
  child.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new McpToolError("shrink_failed", `ffmpeg failed: ${err.trim()}`)));
  child.stdin.end(image);
});

export async function fitForWire(image: Buffer, shrink: Shrink = ffmpegShrink): Promise<{ bytes: Buffer; width: number }> {
  for (const [width, quality] of LADDER) {
    const bytes = await shrink(image, width, quality);
    if (bytes.length <= MAX_WIRE_IMAGE_BYTES) return { bytes, width };
  }
  throw new McpToolError("image_too_large", "The screen is too detailed to send even at 640 px wide.");
}

export class ScreenCaptureAdapter implements CapabilityAdapter {
  readonly family = "screen_capture" as const;
  private readonly capture: () => Promise<{ bytes: Buffer }>;
  private readonly shrink: Shrink | undefined;

  constructor(options: { capture?: () => Promise<{ bytes: Buffer }>; shrink?: Shrink } = {}) {
    const portal = new ScreenshotPortal();
    this.capture = options.capture ?? (() => portal.capture({ interactive: false }));
    this.shrink = options.shrink;
  }

  isAvailable(): boolean {
    return process.platform === "linux" && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS);
  }

  tools(): RegisteredTool[] {
    return [{
      name: "screen.get_screenshot",
      description: "Look at the laptop's screen: returns a screenshot to describe. The robot announces every capture out loud.",
      inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
      permission: "read",
      family: this.family,
      enabled: true,
      handler: async () => {
        const shot = await this.capture();
        const { bytes } = await fitForWire(shot.bytes, this.shrink);
        return { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64"), sizeBytes: bytes.length };
      },
    }];
  }
}
