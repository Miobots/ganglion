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

/**
 * Which part of the screen to look at. A quarter of a 1080p screen fits at its own resolution, so
 * small text that blurs in the whole-screen view becomes readable. Fixed ffmpeg crops, never input.
 */
export const SCREEN_AREAS: Record<string, string | undefined> = {
  whole: undefined,
  top_left: "crop=iw/2:ih/2:0:0",
  top_right: "crop=iw/2:ih/2:iw/2:0",
  bottom_left: "crop=iw/2:ih/2:0:ih/2",
  bottom_right: "crop=iw/2:ih/2:iw/2:ih/2",
  center: "crop=iw/2:ih/2:iw/4:ih/4",
  top: "crop=iw:ih/2:0:0",
  bottom: "crop=iw:ih/2:0:ih/2",
  left: "crop=iw/2:ih:0:0",
  right: "crop=iw/2:ih:iw/2:0",
};

export type Shrink = (image: Buffer, width: number, quality: number, crop?: string) => Promise<Buffer>;

const ffmpegShrink: Shrink = (image, width, quality, crop) => new Promise((resolve, reject) => {
  const filter = [crop, `scale='min(${width},iw)':-2`].filter(Boolean).join(",");
  const child = spawn("ffmpeg", ["-v", "error", "-i", "pipe:0", "-vf", filter, "-q:v", String(quality), "-f", "mjpeg", "pipe:1"], { shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
  child.on("error", (error) => reject(new McpToolError("shrink_unavailable", `Can't shrink the screenshot (is ffmpeg installed?): ${error.message}`)));
  child.on("close", (code) => code === 0 ? resolve(Buffer.concat(out)) : reject(new McpToolError("shrink_failed", `ffmpeg failed: ${err.trim()}`)));
  child.stdin.end(image);
});

export async function fitForWire(image: Buffer, shrink: Shrink = ffmpegShrink, crop?: string): Promise<{ bytes: Buffer; width: number }> {
  for (const [width, quality] of LADDER) {
    const bytes = await shrink(image, width, quality, crop);
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
      description: "Look at the laptop's screen: returns a screenshot to describe. The robot announces every capture out loud. " +
        "The whole screen is shrunk and small text blurs; to read small text, look at one part (for example top_left), which comes back sharp.",
      inputSchema: {
        type: "object",
        properties: { area: { type: "string", enum: Object.keys(SCREEN_AREAS), description: "Which part of the screen; whole by default." } },
        required: [],
        additionalProperties: false,
      },
      permission: "read",
      family: this.family,
      enabled: true,
      handler: async (input: unknown) => {
        const area = (input as { area?: unknown })?.area ?? "whole";
        if (typeof area !== "string" || !(area in SCREEN_AREAS)) {
          throw new McpToolError("invalid_arguments", `area must be one of: ${Object.keys(SCREEN_AREAS).join(", ")}`);
        }
        const shot = await this.capture();
        const { bytes } = await fitForWire(shot.bytes, this.shrink, SCREEN_AREAS[area]);
        return { type: "image", mimeType: "image/jpeg", data: bytes.toString("base64"), sizeBytes: bytes.length };
      },
    }];
  }
}
