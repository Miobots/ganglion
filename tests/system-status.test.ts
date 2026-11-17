import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBattery } from "../src/mcp/adapters/system-status.ts";

describe("G1.1 battery", () => {
  it("reads the first BAT* capacity and status", async () => {
    const root = await mkdtemp(join(tmpdir(), "psu-"));
    await mkdir(join(root, "ADP1"));
    await mkdir(join(root, "BAT0"));
    await writeFile(join(root, "BAT0", "capacity"), "41\n");
    await writeFile(join(root, "BAT0", "status"), "Discharging\n");
    expect(await readBattery(root)).toEqual({ percent: 41, status: "Discharging" });
  });

  it("returns null with no battery or no power_supply directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "psu-"));
    expect(await readBattery(root)).toBeNull();
    expect(await readBattery(join(root, "missing"))).toBeNull();
  });
});
