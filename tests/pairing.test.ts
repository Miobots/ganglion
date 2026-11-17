import { describe, expect, it, spyOn } from "bun:test";
import { mkdir, mkdtemp, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvedFolders, readCredentials, readPairedConfig, savePairing } from "../src/pairing.ts";
import { InMemoryAuditLog, SecureFilesystem } from "../src/mcp/filesystem/secure-filesystem.ts";

describe("pairing storage (G0.2, G0.3)", () => {
  it("saves the token readable by this user only, and reads it back", async () => {
    const dir = join(await mkdtemp(join(tmpdir(), "ganglion-pair-")), "cfg");
    const credentials = { brain_url: "ws://brain/ws", device_id: "laptop-1", token: "t".repeat(64) };
    await savePairing(credentials, {}, dir);
    expect((await stat(join(dir, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect(await readCredentials(dir)).toEqual(credentials);
    expect(await readPairedConfig(dir)).toEqual({});
  });

  it("returns nothing when the laptop was never paired", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ganglion-unpaired-"));
    expect(await readCredentials(dir)).toBeUndefined();
  });

  it("stores approved folders as real paths, read-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-folders-"));
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "link"));
    expect(await approvedFolders([join(root, "link")])).toEqual({
      approvedDirectories: [{ path: join(root, "real"), allowWrite: false }],
    });
    expect(await approvedFolders([])).toBeUndefined();
    await expect(approvedFolders([join(root, "missing")])).rejects.toThrow();
  });

  it("logs a read refused outside the approved folders", async () => {
    const root = await mkdtemp(join(tmpdir(), "ganglion-refusal-"));
    await mkdir(join(root, "approved"));
    const policy = { approvedDirectories: [{ path: join(root, "approved"), allowWrite: false }] };
    const fs = new SecureFilesystem(policy, new InMemoryAuditLog());
    await fs.initialize(policy);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await expect(fs.readFile("/etc/passwd")).rejects.toThrow(/outside approved/);
    expect(warn.mock.calls.some(([line]) => String(line).includes("Refused read outside the approved folders"))).toBe(true);
    warn.mockRestore();
  });
});
