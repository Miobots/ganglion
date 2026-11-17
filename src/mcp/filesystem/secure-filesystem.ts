import { constants as fsConstants } from "node:fs";
import { cp, lstat, mkdir, open, opendir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FilesystemAuditLog, FilesystemLimits, FilesystemPolicy } from "../types.ts";

const DEFAULT_LIMITS: Required<FilesystemLimits> = {
  maxReadBytes: 1_048_576,
  maxWriteBytes: 1_048_576,
  maxSearchBytes: 8_388_608,
  maxSearchResults: 100,
  maxSearchDepth: 8,
  maxDirectoryEntries: 1_000,
  maxSearchEntries: 5_000,
};

export interface FilesystemEntry {
  name: string;
  type: "directory" | "file" | "other";
}

export interface FilesystemSearchMatch {
  path: string;
  matchType: "name" | "content";
  lineNumber?: number;
  excerpt?: string;
}

export class InMemoryAuditLog implements FilesystemAuditLog {
  private readonly records: { operation: string; target: string; timestamp: number }[] = [];

  record(entry: { operation: string; target: string; timestamp: number }): void {
    this.records.push({ ...entry });
  }

  entries(): readonly { operation: string; target: string; timestamp: number }[] {
    return [...this.records];
  }
}

export class SecureFilesystem {
  private readonly approved: { path: string; allowWrite: boolean }[] = [];
  private readonly audit: FilesystemAuditLog;
  private readonly limits: Required<FilesystemLimits>;

  constructor(policy: FilesystemPolicy, audit: FilesystemAuditLog) {
    this.audit = audit;
    this.limits = { ...DEFAULT_LIMITS, ...policy.limits };
    for (const [name, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid filesystem limit: ${name}`);
    }
  }

  async initialize(policy: FilesystemPolicy): Promise<void> {
    this.approved.length = 0;
    for (const directory of policy.approvedDirectories) {
      const canonical = await realpath(directory.path);
      const info = await stat(canonical);
      if (!info.isDirectory()) throw new Error("Approved filesystem path is not a directory");
      this.approved.push({ path: canonical, allowWrite: directory.allowWrite });
    }
  }

  async approvalTarget(
    paths: string[],
    write: boolean | boolean[] = true,
    allowMissing: boolean | boolean[] = true,
  ): Promise<string> {
    const resolved = await Promise.all(paths.map((path, index) => this.target(
      path,
      Array.isArray(write) ? write[index] ?? true : write,
      Array.isArray(allowMissing) ? allowMissing[index] ?? false : allowMissing,
    )));
    return resolved.map((target) => target.path).join(" -> ");
  }

  private async target(path: string, write: boolean, allowMissing = false): Promise<{ path: string; root: string }> {
    if (!path || path.includes("\0")) throw new Error("Invalid filesystem path");
    const absolute = this.absolutePath(path, write);
    const candidate = await this.canonicalCandidate(absolute, allowMissing);
    const root = this.approved.find((item) => isContained(item.path, candidate) && (!write || item.allowWrite));
    if (!root) {
      // G0.3: a request outside the approved folders is refused and logged.
      console.warn(`[Ganglion] Refused ${write ? "write" : "read"} outside the approved folders: ${candidate}`);
      throw new Error("Filesystem path is outside approved directories or not permitted");
    }
    return { path: candidate, root: root.path };
  }

  private displayPath(target: { path: string; root: string }): string {
    const relativePath = relative(target.root, target.path);
    return relativePath === "" ? "." : relativePath;
  }

  private async canonicalCandidate(path: string, allowMissing: boolean): Promise<string> {
    let current = path;
    const missing: string[] = [];
    while (true) {
      try {
        const canonical = await realpath(current);
        if (missing.length > 0 && !(await stat(canonical)).isDirectory()) {
          throw new Error("Parent path is not a directory");
        }
        return resolve(canonical, ...missing.reverse());
      } catch (error) {
        if (!allowMissing || !isNotFound(error)) throw new Error("Filesystem path does not exist");
        const parent = dirname(current);
        if (parent === current) throw new Error("Filesystem path does not exist");
        missing.push(basename(current));
        current = parent;
      }
    }
  }

  private async boundedRead(path: string, maxBytes: number): Promise<Buffer> {
    const handle = await open(path, fsConstants.O_RDONLY);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxBytes) throw new Error("File exceeds the read limit or is not a regular file");
      const buffer = Buffer.alloc(maxBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > maxBytes) throw new Error("File exceeds the read limit");
      return buffer.subarray(0, total);
    } finally {
      await handle.close();
    }
  }

  async list(path?: string): Promise<{ path: string; entries: FilesystemEntry[]; truncated: boolean }> {
    const listPath = path?.trim() ? path : this.defaultApprovedRoot();
    const target = await this.target(listPath, false);
    const info = await stat(target.path);
    if (!info.isDirectory()) throw new Error("Path is not a directory");
    const directory = await opendir(target.path);
    const entries: FilesystemEntry[] = [];
    let truncated = false;
    for await (const entry of directory) {
      if (entries.length >= this.limits.maxDirectoryEntries) {
        truncated = true;
        break;
      }
      entries.push({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    this.audit.record({ operation: "list", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), entries, truncated };
  }

  private defaultApprovedRoot(write = false): string {
    const roots = this.approved.filter((root) => !write || root.allowWrite);
    if (roots.length !== 1) {
      throw new Error("A path is required when zero or multiple approved directories permit this operation");
    }
    return roots[0]!.path;
  }

  private absolutePath(path: string, write: boolean): string {
    return isAbsolute(path) ? resolve(path) : resolve(this.defaultApprovedRoot(write), path);
  }

  async search(path: string | undefined, query: string, includeContent = true, requestedMaxResults?: number): Promise<{
    path: string;
    matches: FilesystemSearchMatch[];
    bytesScanned: number;
    truncated: boolean;
  }> {
    if (!query.trim()) throw new Error("Search query cannot be empty");
    const target = await this.target(path?.trim() || this.defaultApprovedRoot(), false);
    const info = await stat(target.path);
    const maxResults = Math.min(requestedMaxResults ?? this.limits.maxSearchResults, this.limits.maxSearchResults);
    const matches: FilesystemSearchMatch[] = [];
    let bytesScanned = 0;
    let visitedEntries = 0;
    let truncated = false;
    const queue: { path: string; depth: number }[] = info.isDirectory()
      ? [{ path: target.path, depth: 0 }]
      : [{ path: dirname(target.path), depth: 0 }];
    const needle = query.toLocaleLowerCase();

    const addMatch = (match: FilesystemSearchMatch): boolean => {
      if (matches.length >= maxResults) {
        truncated = true;
        return false;
      }
      matches.push(match);
      return true;
    };

    if (!info.isDirectory()) {
      const relativePath = this.displayPath(target);
      if (relativePath.toLocaleLowerCase().includes(needle) && !addMatch({ path: relativePath, matchType: "name" })) {
        return { path: relativePath, matches, bytesScanned, truncated };
      }
      if (includeContent) await this.searchFile(target.path, relativePath, needle, addMatch, (count) => { bytesScanned += count; }, this.limits.maxSearchBytes, () => { truncated = true; });
    } else {
      while (queue.length > 0 && matches.length < maxResults && visitedEntries <= this.limits.maxSearchEntries) {
        const current = queue.shift()!;
        const directory = await opendir(current.path);
        for await (const entry of directory) {
          if (++visitedEntries > this.limits.maxSearchEntries) {
            truncated = true;
            break;
          }
          const entryPath = join(current.path, entry.name);
          const display = this.displayPath({ path: entryPath, root: target.root });
          if (display.toLocaleLowerCase().includes(needle) && !addMatch({ path: display, matchType: "name" })) break;
          if (entry.isDirectory()) {
            if (current.depth < this.limits.maxSearchDepth) queue.push({ path: entryPath, depth: current.depth + 1 });
            else truncated = true;
          } else if (includeContent && entry.isFile()) {
            if (bytesScanned < this.limits.maxSearchBytes) {
              await this.searchFile(entryPath, display, needle, addMatch, (count) => { bytesScanned += count; }, this.limits.maxSearchBytes - bytesScanned, () => { truncated = true; });
            } else {
              truncated = true;
            }
          }
          if (matches.length >= maxResults || visitedEntries > this.limits.maxSearchEntries) {
            truncated = true;
            break;
          }
        }
      }
    }

    this.audit.record({ operation: "search", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), matches, bytesScanned, truncated };
  }

  private async searchFile(
    path: string,
    display: string,
    needle: string,
    addMatch: (match: FilesystemSearchMatch) => boolean,
    addBytes: (count: number) => void,
    byteBudget: number,
    markTruncated: () => void,
  ): Promise<void> {
    if (byteBudget < 1) {
      markTruncated();
      return;
    }
    try {
      const info = await stat(path);
      const maxBytes = Math.min(this.limits.maxReadBytes, byteBudget);
      if (info.size > maxBytes) {
        markTruncated();
        return;
      }
      const buffer = await this.boundedRead(path, maxBytes);
      addBytes(buffer.length);
      if (buffer.includes(0)) return;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index] ?? "";
        if (line.toLocaleLowerCase().includes(needle)) {
          if (!addMatch({ path: display, matchType: "content", lineNumber: index + 1, excerpt: line.slice(0, 240) })) return;
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("read limit")) markTruncated();
    }
  }

  async readFile(path: string): Promise<{ path: string; content: string; sizeBytes: number }> {
    const target = await this.target(path, false);
    const content = await this.boundedRead(target.path, this.limits.maxReadBytes);
    if (content.includes(0)) throw new Error("Binary files are not supported");
    this.audit.record({ operation: "read_file", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), content: content.toString("utf8"), sizeBytes: content.length };
  }

  async getInfo(path?: string): Promise<{ path: string; sizeBytes: number; isDirectory: boolean; modifiedAt: string }> {
    const target = await this.target(path?.trim() || this.defaultApprovedRoot(), false);
    const info = await stat(target.path);
    this.audit.record({ operation: "get_info", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), sizeBytes: info.size, isDirectory: info.isDirectory(), modifiedAt: info.mtime.toISOString() };
  }

  async writeFile(path: string, content: string, overwrite = false): Promise<{ path: string; written: boolean; sizeBytes: number }> {
    const target = await this.target(path, true, true);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.limits.maxWriteBytes) throw new Error("Content exceeds the write limit");
    if (overwrite) await this.rejectSymlink(path, true);
    if (!overwrite && await exists(target.path)) throw new Error("Refusing to overwrite an existing file");
    if (overwrite) {
      const existing = await exists(target.path);
      if (existing && !(await stat(target.path)).isFile()) throw new Error("Only regular files can be overwritten");
    }
    await writeFile(target.path, content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
    this.audit.record({ operation: "write_file", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), written: true, sizeBytes: bytes };
  }

  async createDirectory(path: string): Promise<{ path: string; created: boolean }> {
    const target = await this.target(path, true, true);
    if (await exists(target.path)) throw new Error("Directory path already exists");
    await mkdir(target.path, { recursive: true });
    this.audit.record({ operation: "create_directory", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), created: true };
  }

  async move(source: string, destination: string): Promise<{ source: string; destination: string; moved: boolean }> {
    const from = await this.target(source, true);
    await this.rejectSymlink(source, true);
    const to = await this.target(destination, true, true);
    const info = await stat(from.path);
    if (await exists(to.path)) throw new Error("Refusing to overwrite an existing path");
    if (info.isDirectory() && isContained(from.path, to.path)) throw new Error("Cannot move a directory into itself");
    await rename(from.path, to.path);
    this.audit.record({ operation: "move", target: `${from.path} -> ${to.path}`, timestamp: Date.now() });
    return { source: this.displayPath(from), destination: this.displayPath(to), moved: true };
  }

  async copy(source: string, destination: string): Promise<{ source: string; destination: string; copied: boolean }> {
    const from = await this.target(source, false);
    await this.rejectSymlink(source, false);
    const to = await this.target(destination, true, true);
    const info = await stat(from.path);
    if (await exists(to.path)) throw new Error("Refusing to overwrite an existing path");
    if (info.isDirectory() && isContained(from.path, to.path)) throw new Error("Cannot copy a directory into itself");
    await cp(from.path, to.path, { recursive: true, force: false, errorOnExist: true, dereference: false });
    this.audit.record({ operation: "copy", target: `${from.path} -> ${to.path}`, timestamp: Date.now() });
    return { source: this.displayPath(from), destination: this.displayPath(to), copied: true };
  }

  async delete(path: string, recursive: boolean, confirmed: boolean): Promise<{ path: string; deleted: boolean }> {
    const target = await this.target(path, true);
    await this.rejectSymlink(path, true);
    const info = await stat(target.path);
    if (target.path === target.root) throw new Error("Refusing to delete an approved directory root");
    if (info.isDirectory() && (!recursive || !confirmed)) throw new Error("Recursive directory deletion requires explicit confirmation");
    if (!confirmed) throw new Error("Deletion requires explicit approval");
    await rm(target.path, { recursive, force: false });
    this.audit.record({ operation: recursive ? "delete_recursive" : "delete", target: target.path, timestamp: Date.now() });
    return { path: this.displayPath(target), deleted: true };
  }

  async inspect(path: string): Promise<unknown> {
    return this.getInfo(path);
  }

  async createFile(path: string, content: string): Promise<unknown> {
    return this.writeFile(path, content);
  }

  async rename(source: string, destination: string): Promise<unknown> {
    return this.move(source, destination);
  }

  private async rejectSymlink(path: string, write: boolean): Promise<void> {
    try {
      if ((await lstat(this.absolutePath(path, write))).isSymbolicLink()) {
        throw new Error("Filesystem mutations do not follow symbolic links");
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("symbolic links")) throw error;
      if (!isNotFound(error)) throw error;
    }
  }
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR");
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}