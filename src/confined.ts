import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, rmSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDir, readCredentials, readPairedConfig, type PairedConfig } from "./pairing.ts";
import type { RegisteredAppOrUrl } from "./mcp/adapters/app-launcher.ts";
import { VOLUME_COMMANDS, volumeArgs, type VolumeCommand } from "./mcp/adapters/media-control.ts";

/**
 * `bun run start:confined` — the daemon in its jail (G5.1–G5.3, GANGLION_DECISIONS 36). Linux only.
 *
 * Three layers, outermost first:
 *  1. **bubblewrap**: a private view of the filesystem holding only system files, this code, its
 *     config, the approved folders, registered scripts and the screenshots folder. Home, SSH keys,
 *     browser profiles and the real session bus do not exist in there. Own PID namespace.
 *  2. **xdg-dbus-proxy**: the only D-Bus inside reaches the screenshot portal, media players and
 *     notifications. Not systemd, not the shell, nothing that could start a program outside.
 *  3. **ganglion-sandbox** (C): Landlock (writes only to /tmp, the screenshots folder and writable
 *     approved folders; TCP connect only to the Brain's port; no TCP listen) and a seccomp filter.
 *
 * Registered apps are opened by a broker in this unconfined parent, which reads app names on fd 3
 * and opens only names in its own copy of the registered list. A compromised daemon can ask for
 * the calculator; it cannot ask for anything else.
 */

const repo = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SANDBOX = join(repo, "sandbox", "ganglion-sandbox");

export interface JailOptions {
  config: PairedConfig;
  configDirectory: string;
  brainPort: number;
  /** Filtered session bus socket on the host, or none. */
  busSocket?: string;
  picturesDir?: string;
  /** Program and arguments to run inside. */
  command: string[];
}

/** Host paths that are symlinks (merged /usr) are recreated as symlinks; directories are bound. */
function systemBinds(): string[] {
  const args = ["--ro-bind", "/usr", "/usr", "--ro-bind", "/etc", "/etc", "--ro-bind", "/sys", "/sys"];
  for (const path of ["/bin", "/sbin", "/lib", "/lib64", "/lib32"]) {
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink()) args.push("--symlink", readlinkSync(path), path);
    else args.push("--ro-bind", path, path);
  }
  return args;
}

/** The bubblewrap + ganglion-sandbox command line. Pure, so the jail's shape is tested. */
export function jailArgs(options: JailOptions): string[] {
  const { config } = options;
  const runtime = process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`;
  const protocol = resolve(repo, "../miobots-protocol");
  const bunDir = dirname(process.execPath);
  const readable = [repo, ...(existsSync(protocol) ? [protocol] : []), bunDir, options.configDirectory];
  const folders = config.filesystem?.approvedDirectories ?? [];
  const scripts = (config.scripts ?? []).map((script) => script.path);
  const writable = ["/tmp", "/dev", ...(options.picturesDir ? [options.picturesDir] : []), ...folders.filter((f) => f.allowWrite).map((f) => f.path)];

  const bwrap = [
    "--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    ...systemBinds(),
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp",
    ...readable.flatMap((path) => ["--ro-bind", path, path]),
    ...folders.flatMap((folder) => [folder.allowWrite ? "--bind" : "--ro-bind", folder.path, folder.path]),
    ...scripts.flatMap((path) => ["--ro-bind", path, path]),
    ...(options.picturesDir ? ["--bind", options.picturesDir, options.picturesDir] : []),
    "--dir", runtime,
    ...(options.busSocket
      ? ["--bind", options.busSocket, join(runtime, "bus"), "--setenv", "DBUS_SESSION_BUS_ADDRESS", `unix:path=${join(runtime, "bus")}`]
      : ["--unsetenv", "DBUS_SESSION_BUS_ADDRESS"]),
    "--chdir", repo,
  ];
  const landlock = [
    SANDBOX,
    "--ro", "/",
    ...writable.flatMap((path) => ["--rw", path]),
    "--connect-port", String(options.brainPort),
  ];
  return [...bwrap, "--", ...landlock, "--", ...options.command];
}

/** Compiles the C launcher if it is missing or older than its source. */
export function buildSandbox(): string {
  const source = join(repo, "sandbox", "ganglion-sandbox.c");
  if (!existsSync(SANDBOX) || statSync(SANDBOX).mtimeMs < statSync(source).mtimeMs) {
    const result = spawnSync("cc", ["-O2", "-Wall", "-o", SANDBOX, source], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Could not compile sandbox/ganglion-sandbox.c (is a C compiler installed?)");
  }
  return SANDBOX;
}

/** The only D-Bus names the jailed daemon may talk to. */
export const BUS_TALK = ["org.freedesktop.portal.Desktop", "org.freedesktop.Notifications", "org.mpris.MediaPlayer2.*"];

async function startBusProxy(): Promise<{ socket: string; proxy: ChildProcess } | undefined> {
  const address = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (!address) return undefined;
  const runtime = process.env.XDG_RUNTIME_DIR ?? "/tmp";
  const socket = join(runtime, `miobots-ganglion-bus-${process.pid}`);
  const proxy = spawn("xdg-dbus-proxy", [address, socket, "--filter", ...BUS_TALK.map((name) => `--talk=${name}`)], { stdio: "inherit" });
  for (let i = 0; i < 100 && !existsSync(socket); i++) await new Promise((r) => setTimeout(r, 20));
  if (!existsSync(socket)) throw new Error("xdg-dbus-proxy did not start");
  return { socket, proxy };
}

/**
 * What the broker does for the jailed daemon: open a registered app or URL by name, or one of the
 * fixed volume commands. Nothing else; every other line is refused.
 */
export function brokerOpen(apps: RegisteredAppOrUrl[], line: string): string {
  let request: { name?: unknown; volume?: unknown };
  try { request = JSON.parse(line) as typeof request; } catch { return "malformed request"; }
  if (request.volume !== undefined) {
    if (!VOLUME_COMMANDS.includes(request.volume as VolumeCommand)) return `refused: volume ${JSON.stringify(request.volume)}`;
    spawn("wpctl", volumeArgs(request.volume as VolumeCommand), { stdio: "ignore" }).on("error", () => undefined);
    return `volume ${request.volume}`;
  }
  const name = request.name;
  const entry = apps.find((app) => typeof name === "string" && app.name.toLowerCase() === name.trim().toLowerCase());
  if (!entry) return `refused: ${JSON.stringify(name)} is not registered`;
  const child = entry.type === "url"
    ? spawn("xdg-open", [entry.target], { detached: true, stdio: "ignore" })
    : spawn(entry.target, entry.args ?? [], { detached: true, stdio: "ignore", shell: false });
  child.on("error", (error) => console.warn(`[broker] ${entry.name}: ${error.message}`));
  child.unref();
  return `opened ${entry.name}`;
}

async function main(): Promise<void> {
  if (process.platform !== "linux") throw new Error("Confinement is Linux-only; use bun start elsewhere.");
  const credentials = await readCredentials();
  const config = (await readPairedConfig()) ?? {};
  const brainUrl = new URL(process.env.BRAIN_WS_URL ?? credentials?.brain_url ?? "ws://127.0.0.1:8080/ws");
  const brainPort = Number(brainUrl.port || (brainUrl.protocol === "wss:" ? 443 : 80));
  buildSandbox();
  const bus = await startBusProxy();
  const pictures = spawnSync("xdg-user-dir", ["PICTURES"], { encoding: "utf8" }).stdout?.trim() || join(homedir(), "Pictures");
  const args = jailArgs({ config, configDirectory: configDir(), brainPort, ...(bus ? { busSocket: bus.socket } : {}), picturesDir: pictures, command: [process.execPath, "src/main.ts"] });

  const jail = spawn("bwrap", args, { stdio: ["inherit", "inherit", "inherit", "pipe"], env: { ...process.env, GANGLION_BROKER_FD: "3" } });
  const apps = config.appLauncher?.allowedTargets ?? [];
  const requests = jail.stdio[3];
  if (requests && "on" in requests) {
    createInterface({ input: requests as NodeJS.ReadableStream }).on("line", (line) => console.log(`[broker] ${brokerOpen(apps, line)}`));
  }
  // xdg-dbus-proxy leaves its socket file behind when killed.
  const closeBus = () => { bus?.proxy.kill(); if (bus) rmSync(bus.socket, { force: true }); };
  const stop = () => { jail.kill("SIGTERM"); closeBus(); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  jail.on("exit", (code) => { closeBus(); process.exit(code ?? 1); });
}

if (import.meta.main) await main();
