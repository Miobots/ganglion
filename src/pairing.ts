import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FilesystemPolicy } from "./mcp/types.ts";

/**
 * Where a paired daemon keeps what pairing gave it (G0.2, G0.3).
 *
 * `credentials.json` holds this laptop's own token, readable by this user only. `config.json` holds
 * the approved folders a human named at pairing. No tool writes either file, so the agent can never
 * widen the folder list; only re-pairing or a human editing the file can.
 */
export interface Credentials {
  brain_url: string;
  device_id: string;
  token: string;
}

export interface PairedConfig {
  filesystem?: FilesystemPolicy;
}

export function configDir(): string {
  return process.env.GANGLION_CONFIG_DIR
    ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "miobots-ganglion");
}

/** Resolves each folder to its real path and checks it is a directory. Read-only by default. */
export async function approvedFolders(folders: string[]): Promise<FilesystemPolicy | undefined> {
  if (folders.length === 0) return undefined;
  const approvedDirectories = [];
  for (const folder of folders) {
    const real = await realpath(folder);
    if (!(await stat(real)).isDirectory()) throw new Error(`Not a folder: ${folder}`);
    approvedDirectories.push({ path: real, allowWrite: false });
  }
  return { approvedDirectories };
}

export async function savePairing(credentials: Credentials, config: PairedConfig, dir = configDir()): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const credentialsPath = join(dir, "credentials.json");
  await writeFile(credentialsPath, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600); // writeFile's mode does not apply to an existing file
  await writeFile(join(dir, "config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readCredentials(dir = configDir()): Promise<Credentials | undefined> {
  return readJson<Credentials>(join(dir, "credentials.json"));
}

export function readPairedConfig(dir = configDir()): Promise<PairedConfig | undefined> {
  return readJson<PairedConfig>(join(dir, "config.json"));
}
