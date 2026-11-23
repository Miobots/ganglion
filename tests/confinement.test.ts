import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brokerOpen, buildSandbox, jailArgs } from "../src/confined.ts";

// Needs Linux, bubblewrap that may create namespaces here, a C compiler, and Landlock ABI 4+.
const usable = process.platform === "linux"
  && spawnSync("bwrap", ["--ro-bind", "/", "/", "true"]).status === 0
  && spawnSync("cc", ["--version"]).status === 0;

const listen = () => new Promise<Server>((resolve) => { const server = createServer((s) => s.destroy()); server.listen(0, "127.0.0.1", () => resolve(server)); });
const portOf = (server: Server) => (server.address() as { port: number }).port;

describe("the daemon's jail (G5)", () => {
  it("builds a jail with no home, no real bus, and the Brain's port only", () => {
    const args = jailArgs({ config: { filesystem: { approvedDirectories: [{ path: "/srv/docs", allowWrite: false }] } }, configDirectory: "/cfg", brainPort: 8080, command: ["bun", "src/main.ts"] });
    const joined = args.join(" ");
    expect(joined).toContain("--ro-bind /srv/docs /srv/docs");
    expect(joined).toContain("--unshare-pid");
    expect(joined).toContain("--unsetenv DBUS_SESSION_BUS_ADDRESS");
    expect(joined).toContain("--connect-port 8080");
    const home = process.env.HOME ?? "/home/";
    expect(args.some((arg, i) => (args[i - 1] === "--ro-bind" || args[i - 1] === "--bind") && arg === home)).toBe(false);
  });

  it("the broker opens only registered apps", () => {
    expect(brokerOpen([{ name: "calc", type: "app", target: "/bin/true" }], JSON.stringify({ name: "Calc" }))).toBe("opened calc");
    expect(brokerOpen([{ name: "calc", type: "app", target: "/bin/true" }], JSON.stringify({ name: "/bin/sh" }))).toContain("refused");
    expect(brokerOpen([], "rm -rf /")).toBe("malformed request");
    expect(brokerOpen([], JSON.stringify({ volume: "set-volume 100" }))).toContain("refused");
  });

  it.skipIf(!usable)("a hostile program inside fails at everything but its own folder and the Brain (G5.4)", async () => {
    buildSandbox();
    const approved = mkdtempSync(join(tmpdir(), "ganglion-approved-"));
    writeFileSync(join(approved, "notes.txt"), "fine");
    const secret = join(mkdtempSync(join(tmpdir(), "ganglion-secret-")), "key.txt");
    writeFileSync(secret, "s3cret");
    const brain = await listen();
    const other = await listen();
    const realBus = `${process.env.XDG_RUNTIME_DIR ?? "/run/user/1000"}/bus`;
    const args = jailArgs({
      config: { filesystem: { approvedDirectories: [{ path: approved, allowWrite: false }] } },
      configDirectory: approved,
      brainPort: portOf(brain),
      command: [process.execPath, join(import.meta.dir, "fixtures/hostile.ts"), join(approved, "notes.txt"), secret, approved, String(portOf(brain)), String(portOf(other)), realBus],
    });
    const run = spawnSync("bwrap", args, { encoding: "utf8" });
    brain.close();
    other.close();
    const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!) as Record<string, string>;
    console.log(result);
    expect(result["read approved file"]).toBe("ok");
    expect(result["connect to the Brain's port"]).toBe("ok");
    for (const name of ["read a file outside the folders", "write into a read-only approved folder", "read a file in the home directory", "write outside /tmp", "create a namespace", "connect to any other TCP port", "connect to the real session bus", "listen on a TCP port"]) {
      expect(result[name], name).toStartWith("refused");
    }
    expect(result["what the home directory shows"]).toBe(".bun");
  }, 30_000);
});
