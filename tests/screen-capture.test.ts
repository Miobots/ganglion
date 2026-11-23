import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { fitForWire, MAX_WIRE_IMAGE_BYTES, ScreenCaptureAdapter } from "../src/mcp/adapters/screen-capture.ts";
import { encode, Kind, newEnvelope, SequenceCounter, Topics } from "@miobots/protocol";

describe("screen capture (G4.1)", () => {
  it("steps down until the image fits one protocol message", async () => {
    const tried: string[] = [];
    const sizes: Record<string, number> = { "1280/10": 90_000, "1280/16": 60_000, "1024/14": 40_000 };
    const fit = await fitForWire(Buffer.alloc(10), async (_image, width, quality) => {
      tried.push(`${width}/${quality}`);
      return Buffer.alloc(sizes[`${width}/${quality}`] ?? 1);
    });
    expect(tried).toEqual(["1280/10", "1280/16", "1024/14"]);
    expect(fit.width).toBe(1024);
  });

  it("gives up with a clear error when even the smallest step is too big", async () => {
    await expect(fitForWire(Buffer.alloc(10), async () => Buffer.alloc(MAX_WIRE_IMAGE_BYTES + 1))).rejects.toThrow("too detailed");
  });

  it("a full-size image fits one envelope once base64-encoded", () => {
    const data = Buffer.alloc(MAX_WIRE_IMAGE_BYTES, 0xab).toString("base64");
    const envelope = newEnvelope({
      kind: Kind.EVT, topic: Topics.MCP_RESPONSE, corr_id: "c", seq: new SequenceCounter(),
      payload: { jsonrpc: "2.0", id: "1", result: { content: [{ type: "image", data, mimeType: "image/jpeg" }] } } as never,
    });
    expect(() => encode(envelope)).not.toThrow();
  });

  it("is a Read tool that returns a JPEG, and crops to a fixed area on request", async () => {
    const crops: (string | undefined)[] = [];
    const tool = new ScreenCaptureAdapter({ capture: async () => ({ bytes: Buffer.from("png") }), shrink: async (_i, _w, _q, crop) => { crops.push(crop); return Buffer.from([0xff, 0xd8, 0xff, 1]); } }).tools()[0]!;
    expect(tool.permission).toBe("read");
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, properties: { area: { enum: expect.arrayContaining(["whole", "top_left", "center"]) } } });
    await tool.handler({ area: "top_left" }, {});
    expect(crops).toEqual(["crop=iw/2:ih/2:0:0"]);
    await expect(tool.handler({ area: "crop=iw:ih:0:0,drawtext" }, {})).rejects.toThrow("area must be one of");
    crops.length = 0;
    expect(await tool.handler({}, {})).toEqual({ type: "image", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 1]).toString("base64"), sizeBytes: 4 });
  });

  it("shrinks a real image with ffmpeg", async () => {
    // A 1×1 PNG.
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const { bytes } = await fitForWire(png);
    expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    // A 4×2 image cropped to its top-left quarter is 2×1.
    const wide = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=red:size=4x2", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "pipe:1"]).stdout;
    expect((await fitForWire(wide, undefined, "crop=iw/2:ih/2:0:0")).bytes.length).toBeGreaterThan(0);
  });
});
