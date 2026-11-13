import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FilesystemAuditLog, FilesystemPolicy, RegisteredTool, ToolSchema } from "./types.ts";

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class InMemoryAuditLog implements FilesystemAuditLog {
  private readonly records: { operation: string; target: string; timestamp: number }[] = [];
  record(entry: { operation: string; target: string; timestamp: number }): void { this.records.push({ ...entry }); }
  entries(): readonly { operation: string; target: string; timestamp: number }[] { return [...this.records]; }
}

export class SecureFilesystem {
  private readonly approved: { path: string; allowWrite: boolean }[];
  private readonly policy: FilesystemPolicy;
  private readonly audit: FilesystemAuditLog;

  constructor(policy: FilesystemPolicy, audit: FilesystemAuditLog) {
    this.policy = policy;
    this.audit = audit;
    this.approved = [];
  }

  async initialize(): Promise<void> {
    this.approved.length = 0;
    for (const directory of this.policy.approvedDirectories) {
      const canonical = await realpath(directory.path);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error("Approved filesystem path is not a directory");
      this.approved.push({ path: canonical, allowWrite: directory.allowWrite });
    }
  }

  private async target(path: string, write: boolean, allowMissing = false): Promise<{ path: string; root: string }> {
    if (!path || path.includes("\0")) throw new Error("Invalid filesystem path");
    const absolute = resolve(path);
    for (const root of this.approved) {
      const candidate = await this.canonicalCandidate(absolute, allowMissing);
      if (isContained(root.path, candidate) && (!write || root.allowWrite)) return { path: candidate, root: root.path };
    }
    throw new Error("Filesystem path is outside approved directories or not permitted");
  }

  private displayPath(target: { path: string; root: string }): string {
    const relativePath = relative(target.root, target.path);
    return relativePath === "" ? "." : relativePath;
  }

  private async canonicalCandidate(path: string, allowMissing: boolean): Promise<string> {
    try { return await realpath(path); } catch {
      if (!allowMissing) throw new Error("Filesystem path does not exist");
      const parent = await realpath(dirname(path));
      return join(parent, path.slice(dirname(path).length));
    }
  }

  async listDirectory(path: string): Promise<unknown> {
    const target = await this.target(path, false);
    const entries = await readdir(target.path, { withFileTypes: true });
    this.audit.record({ operation: "list_directory", target: target.path, timestamp: Date.now() });
    return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other" }));
  }

  async readFile(path: string): Promise<unknown> {
    const target = await this.target(path, false);
    const info = await stat(target.path);
    if (!info.isFile() || info.size > 1_048_576) throw new Error("File is unavailable or exceeds the read limit");
    const content = await readFile(target.path, "utf8");
    this.audit.record({ operation: "read_file", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), content, sizeBytes: info.size };
  }

  async inspect(path: string): Promise<unknown> {
    const target = await this.target(path, false);
    const info = await stat(target.path);
    this.audit.record({ operation: "inspect", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), sizeBytes: info.size, isDirectory: info.isDirectory(), modifiedAt: info.mtime.toISOString() };
  }

  async createFile(path: string, content: string): Promise<unknown> {
    const target = await this.target(path, true, true);
    if (await exists(target.path)) throw new Error("Refusing to overwrite an existing file");
    await writeFile(target.path, content, { encoding: "utf8", flag: "wx" });
    this.audit.record({ operation: "create_file", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), created: true };
  }

  async createDirectory(path: string): Promise<unknown> {
    const target = await this.target(path, true, true);
    await mkdir(target.path, { recursive: false });
    this.audit.record({ operation: "create_directory", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), created: true };
  }

  async move(source: string, destination: string): Promise<unknown> {
    const from = await this.target(source, true);
    const to = await this.target(destination, true, true);
    if (await exists(to.path)) throw new Error("Refusing to overwrite an existing path");
    await rename(from.path, to.path);
    this.audit.record({ operation: "move", target: `${from.path} -> ${to.path}`, timestamp: Date.now() });
    return { source: this.displayPath(from), destination: this.displayPath(to), moved: true };
  }

  async rename(source: string, destination: string): Promise<unknown> {
    return this.move(source, destination);
  }

  async delete(path: string, recursive: boolean, confirmed: boolean): Promise<unknown> {
    const target = await this.target(path, true);
    const info = await stat(target.path);
    if (target.path === target.root) throw new Error("Refusing to delete an approved directory root");
    if (info.isDirectory() && (!recursive || !confirmed)) throw new Error("Recursive directory deletion requires explicit confirmation");
    if (!confirmed) throw new Error("Deletion requires explicit approval");
    await rm(target.path, { recursive, force: false });
    this.audit.record({ operation: recursive ? "delete_recursive" : "delete", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), deleted: true };
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function filesystemTools(filesystem: SecureFilesystem): RegisteredTool[] {
  return [
    { name: "filesystem.list_directory", description: "List approved directory contents.", inputSchema: objectSchema({ path: stringSchema() }), permission: "read", family: "filesystem", enabled: true, handler: async (input) => filesystem.listDirectory((input as { path: string }).path) },
    { name: "filesystem.read_file", description: "Read an approved text file.", inputSchema: objectSchema({ path: stringSchema() }), permission: "read", family: "filesystem", enabled: true, handler: async (input) => filesystem.readFile((input as { path: string }).path) },
    { name: "filesystem.get_metadata", description: "Inspect approved path metadata.", inputSchema: objectSchema({ path: stringSchema() }), permission: "read", family: "filesystem", enabled: true, handler: async (input) => filesystem.inspect((input as { path: string }).path) },
    { name: "filesystem.create_file", description: "Create a new file without overwriting.", inputSchema: objectSchema({ path: stringSchema(), content: stringSchema() }), permission: "action", family: "filesystem", enabled: true, handler: async (input) => filesystem.createFile((input as { path: string; content: string }).path, (input as { content: string }).content) },
    { name: "filesystem.create_directory", description: "Create a directory inside an approved directory.", inputSchema: objectSchema({ path: stringSchema() }), permission: "action", family: "filesystem", enabled: true, handler: async (input) => filesystem.createDirectory((input as { path: string }).path) },
    { name: "filesystem.move", description: "Move a file or directory without overwriting.", inputSchema: objectSchema({ source: stringSchema(), destination: stringSchema() }), permission: "action", family: "filesystem", enabled: true, handler: async (input) => filesystem.move((input as { source: string; destination: string }).source, (input as { destination: string }).destination) },
    { name: "filesystem.rename", description: "Rename a file or directory without overwriting.", inputSchema: objectSchema({ source: stringSchema(), destination: stringSchema() }), permission: "action", family: "filesystem", enabled: true, handler: async (input) => filesystem.rename((input as { source: string; destination: string }).source, (input as { destination: string }).destination) },
    { name: "filesystem.delete", description: "Delete an approved file or directory with explicit confirmation.", inputSchema: objectSchema({ path: stringSchema(), recursive: { type: "boolean", description: "Delete directories recursively." }, confirmed: { type: "boolean", description: "Explicitly confirm the deletion." } }, ["path"]), permission: "action", family: "filesystem", enabled: true, handler: async (input) => { const value = input as { path: string; recursive?: boolean; confirmed?: boolean }; return filesystem.delete(value.path, value.recursive === true, value.confirmed === true); } },
  ];
}

function stringSchema(): ToolSchema { return { type: "string", minLength: 1 }; }
function objectSchema(properties: Record<string, ToolSchema>, required = Object.keys(properties)): ToolSchema {
  return { type: "object", properties, required, additionalProperties: false };
}
