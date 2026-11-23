import { describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFolder, removeFolder, runSettings, setTier } from "../src/settings.ts";
import { readPairedConfig, savePairedConfig } from "../src/pairing.ts";

describe("settings window (G6.1)", () => {
  it("sets one tool's level, and returning to the default removes the override", () => {
    const changed = setTier({}, "media_control", "action", "read");
    expect(changed).toEqual({ tiers: { media_control: "action" } });
    expect(setTier(changed, "media_control", "read", "read")).toEqual({});
  });

  it("adds folders by their real path, read-only, and removes them", async () => {
    const folder = mkdtempSync(join(tmpdir(), "ganglion-folder-"));
    const added = await addFolder({}, folder);
    expect(added.filesystem?.approvedDirectories).toEqual([{ path: realpathSync(folder), allowWrite: false }]);
    expect(removeFolder(added, realpathSync(folder))).toEqual({});
    await expect(addFolder({}, join(folder, "missing"))).rejects.toThrow();
  });

  it("walks the dialogs and saves only config.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ganglion-settings-"));
    const folder = mkdtempSync(join(tmpdir(), "ganglion-folder-"));
    await savePairedConfig({ scripts: [{ id: "hello", path: "/bin/true" }] }, dir);
    const answers = ["Tool permissions", "run_script", "Run without asking", "Approvals on this laptop", "Approved folders", "Add a folder…", folder, "Save and close", ""];
    const shown: string[][] = [];
    await runSettings((args) => { shown.push(args); return { ok: true, out: answers.shift() ?? "" }; }, dir);
    expect(await readPairedConfig(dir)).toEqual({
      scripts: [{ id: "hello", path: "/bin/true" }],
      tiers: { run_script: "read" },
      desktopApprovals: true,
      filesystem: { approvedDirectories: [{ path: realpathSync(folder), allowWrite: false }] },
    });
    const toolList = shown.find((args) => args.includes("--title=Tool permissions"))!;
    expect(toolList).toContain("run_script");
    expect(toolList.join(" ")).toContain("There is no switch for every tool");
  });
});
