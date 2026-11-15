import { isAbsolute } from "node:path";
import type { FilesystemLimits, FilesystemPolicy } from "../types.ts";

const limitNames = new Set<keyof FilesystemLimits>([
  "maxReadBytes",
  "maxWriteBytes",
  "maxSearchBytes",
  "maxSearchResults",
  "maxSearchDepth",
  "maxDirectoryEntries",
  "maxSearchEntries",
]);

export function parseFilesystemPolicy(value?: string): FilesystemPolicy | undefined {
  if (!value?.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GANGLION_FILESYSTEM_POLICY must be valid JSON");
  }

  if (!isRecord(parsed) || !hasOnlyKeys(parsed, ["approvedDirectories", "limits"]) || !Array.isArray(parsed.approvedDirectories) || parsed.approvedDirectories.length === 0) {
    throw new Error("GANGLION_FILESYSTEM_POLICY must contain approvedDirectories");
  }

  const approvedDirectories = parsed.approvedDirectories.map((directory) => {
    if (!isRecord(directory) || !hasOnlyKeys(directory, ["path", "allowWrite"]) ||
        typeof directory.path !== "string" || !isAbsolute(directory.path) || typeof directory.allowWrite !== "boolean") {
      throw new Error("Each approved directory requires an absolute path and allowWrite boolean");
    }
    return { path: directory.path, allowWrite: directory.allowWrite };
  });

  let limits: Partial<FilesystemLimits> | undefined;
  if (parsed.limits !== undefined) {
    if (!isRecord(parsed.limits) || !hasOnlyKeys(parsed.limits, [...limitNames])) {
      throw new Error("Filesystem limits contain an unsupported setting");
    }
    for (const [name, limit] of Object.entries(parsed.limits)) {
      if (!Number.isSafeInteger(limit) || (limit as number) < 1) {
        throw new Error(`Filesystem limit ${name} must be a positive integer`);
      }
    }
    limits = parsed.limits as Partial<FilesystemLimits>;
  }

  return { approvedDirectories, ...(limits ? { limits } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}