import { spawnSync } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createGanglionMcpServer } from "./mcp/bootstrap.ts";
import { parseFilesystemPolicy } from "./mcp/filesystem/policy.ts";
import { parseAppLauncherPolicy } from "./mcp/adapters/app-launcher.ts";
import { parseScripts } from "./mcp/adapters/script-runner.ts";
import { parseConnectors } from "./mcp/adapters/connectors.ts";
import { configDir, readPairedConfig, savePairedConfig, type PairedConfig } from "./pairing.ts";
import type { GanglionTransport, PermissionTier } from "./mcp/types.ts";

/**
 * `bun run settings` — the desktop window where the human changes permissions (G6.1,
 * GANGLION_DECISIONS 9, 35). Plain GNOME dialogs (zenity), opened by the human, writing only
 * `config.json`. It never opens a port and the agent cannot reach it.
 *
 * - Each tool's level, one tool at a time: "ask on the phone" (Action) or "run without asking"
 *   (Read). There is no switch for all tools at once, by design.
 * - The approved folders, read-only.
 * - Whether this laptop also shows approvals (G2.3).
 *
 * The daemon reads `config.json` when it starts; restart it to apply.
 */

/** Sets one tool's level; going back to its default removes the override. */
export function setTier(config: PairedConfig, tool: string, tier: PermissionTier, defaultTier: PermissionTier): PairedConfig {
  const tiers = { ...(config.tiers ?? {}) };
  if (tier === defaultTier) delete tiers[tool];
  else tiers[tool] = tier;
  const { tiers: _old, ...rest } = config;
  return Object.keys(tiers).length ? { ...rest, tiers } : rest;
}

export async function addFolder(config: PairedConfig, folder: string): Promise<PairedConfig> {
  const real = await realpath(folder); // resolve first: the policy compares real paths
  if (!(await stat(real)).isDirectory()) throw new Error(`Not a folder: ${folder}`);
  const folders = config.filesystem?.approvedDirectories ?? [];
  if (folders.some((entry) => entry.path === real)) return config;
  return { ...config, filesystem: { ...(config.filesystem ?? {}), approvedDirectories: [...folders, { path: real, allowWrite: false }] } };
}

export function removeFolder(config: PairedConfig, folder: string): PairedConfig {
  const folders = (config.filesystem?.approvedDirectories ?? []).filter((entry) => entry.path !== folder);
  const { filesystem: _old, ...rest } = config;
  return folders.length ? { ...rest, filesystem: { ...(config.filesystem ?? {}), approvedDirectories: folders } } : rest;
}

type Zenity = (args: string[]) => { ok: boolean; out: string };
const zenity: Zenity = (args) => {
  const result = spawnSync("zenity", args, { encoding: "utf8" });
  return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
};

const LEVEL = { action: "Ask on the phone", read: "Run without asking" } as const;

/** Every tool this daemon would offer, with the level its code gives it. */
async function defaultTools(config: PairedConfig): Promise<{ name: string; tier: PermissionTier }[]> {
  const idle = { start: async () => {}, send: async () => {}, close: async () => {} } as unknown as GanglionTransport;
  const filesystem = parseFilesystemPolicy(config.filesystem ? JSON.stringify(config.filesystem) : undefined);
  const appLauncher = parseAppLauncherPolicy(config.appLauncher ? JSON.stringify(config.appLauncher) : undefined);
  const scripts = parseScripts(config.scripts ? JSON.stringify(config.scripts) : undefined);
  const connectors = parseConnectors(config.connectors);
  const server = await createGanglionMcpServer(idle, {
    ...(filesystem ? { filesystem } : {}), ...(appLauncher ? { appLauncher } : {}), ...(scripts ? { scripts } : {}), ...(connectors ? { connectors } : {}),
  });
  const tools = server.registry.listEnabled().map((tool) => ({ name: tool.name, tier: tool.permission }));
  await server.close().catch(() => undefined);
  return tools;
}

export async function runSettings(ask: Zenity = zenity, dir = configDir()): Promise<void> {
  let config = (await readPairedConfig(dir)) ?? {};
  const tools = await defaultTools(config);
  for (;;) {
    const folders = config.filesystem?.approvedDirectories ?? [];
    const menu = ask(["--list", "--title=MioBots laptop settings", "--width=560", "--height=360",
      "--text=Mio can only use what is listed here. Changes apply when the daemon restarts.",
      "--column=Setting", "--column=Now", "--hide-header",
      "Tool permissions", `${Object.keys(config.tiers ?? {}).length} changed from default`,
      "Approved folders", `${folders.length} folder(s), read-only`,
      "Approvals on this laptop", config.desktopApprovals ? "On" : "Off",
      "Save and close", ""]);
    if (!menu.ok) return; // closed without saving
    if (menu.out === "Save and close") {
      await savePairedConfig(config, dir);
      ask(["--info", "--title=Saved", "--text=Saved. Restart the daemon (bun start) to apply."]);
      return;
    }
    if (menu.out === "Approvals on this laptop") {
      config = { ...config, desktopApprovals: !config.desktopApprovals };
    }
    if (menu.out === "Approved folders") {
      const pick = ask(["--list", "--title=Approved folders", "--width=560", "--height=360", "--text=Pick a folder to remove it, or add one.",
        "--column=Folder", "Add a folder…", ...folders.map((entry) => entry.path)]);
      if (pick.ok && pick.out === "Add a folder…") {
        const chosen = ask(["--file-selection", "--directory", "--title=Folder Mio may read"]);
        if (chosen.ok && chosen.out) config = await addFolder(config, chosen.out);
      } else if (pick.ok && pick.out) {
        if (ask(["--question", `--text=Stop letting Mio read ${pick.out}?`]).ok) config = removeFolder(config, pick.out);
      }
    }
    if (menu.out === "Tool permissions") {
      const rows = tools.flatMap((tool) => [tool.name, LEVEL[config.tiers?.[tool.name] ?? tool.tier], LEVEL[tool.tier]]);
      const pick = ask(["--list", "--title=Tool permissions", "--width=640", "--height=480",
        "--text=One tool at a time. There is no switch for every tool, by design.",
        "--column=Tool", "--column=Now", "--column=Default", ...rows]);
      const tool = tools.find((candidate) => candidate.name === pick.out);
      if (pick.ok && tool) {
        const level = ask(["--list", "--radiolist", `--title=${tool.name}`, "--width=420", "--height=240", "--column=", "--column=Level",
          String((config.tiers?.[tool.name] ?? tool.tier) === "action"), LEVEL.action,
          String((config.tiers?.[tool.name] ?? tool.tier) === "read"), LEVEL.read]);
        if (level.ok && level.out) config = setTier(config, tool.name, level.out === LEVEL.read ? "read" : "action", tool.tier);
      }
    }
  }
}

if (import.meta.main) await runSettings();
