import type { ProcessManagementConfiguration } from "./types.ts";

const CONFIG_KEYS = new Set([
  "enabled",
  "protectedPids",
  "ganglionPid",
  "clockTicksPerSecond",
  "sampleIntervalMs",
]);

export function parseProcessManagementConfiguration(value?: string): ProcessManagementConfiguration | undefined {
  if (!value?.trim()) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GANGLION_PROCESS_MANAGEMENT must be valid JSON");
  }
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !CONFIG_KEYS.has(key)) || typeof parsed.enabled !== "boolean") {
    throw new Error("GANGLION_PROCESS_MANAGEMENT must contain enabled and supported settings only");
  }

  const protectedPids = parsed.protectedPids;
  if (protectedPids !== undefined && (!Array.isArray(protectedPids) || protectedPids.some((pid) => !isPositiveSafeInteger(pid)))) {
    throw new Error("protectedPids must be an array of positive safe integer PIDs");
  }

  const ganglionPid = parsed.ganglionPid;
  if (ganglionPid !== undefined && !isPositiveSafeInteger(ganglionPid)) {
    throw new Error("ganglionPid must be a positive safe integer");
  }

  const clockTicksPerSecond = parsed.clockTicksPerSecond;
  if (clockTicksPerSecond !== undefined && !isPositiveSafeInteger(clockTicksPerSecond)) {
    throw new Error("clockTicksPerSecond must be a positive safe integer");
  }

  const sampleIntervalMs = parsed.sampleIntervalMs;
  if (sampleIntervalMs !== undefined && !isPositiveSafeInteger(sampleIntervalMs)) {
    throw new Error("sampleIntervalMs must be a positive safe integer");
  }

  return {
    enabled: parsed.enabled,
    ...(protectedPids === undefined ? {} : { protectedPids: [...protectedPids as number[]] }),
    ...(ganglionPid === undefined ? {} : { ganglionPid: ganglionPid as number }),
    ...(clockTicksPerSecond === undefined ? {} : { clockTicksPerSecond: clockTicksPerSecond as number }),
    ...(sampleIntervalMs === undefined ? {} : { sampleIntervalMs: sampleIntervalMs as number }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}