import { readFile, readlink, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { ProcessCpuSampler } from "./process-cpu-sampler.ts";
import type {
  LinuxProcessState,
  ProcessEnumerationResult,
  ProcessInfo,
  ProcessInspectionError,
  ProcessInspectionErrorReason,
  ProcessInspectionField,
  ProcessInspectionResult,
} from "./types.ts";

export interface ProcessInspectorOptions {
  procRoot?: string;
  clockTicksPerSecond?: number;
  resolveUsername?: (uid: number) => Promise<string | null>;
  fileSystem?: ProcessInspectorFileSystem;
  cpuSampler?: ProcessCpuSampler;
}

export interface ProcessInspectorFileSystem {
  readText(path: string): Promise<string>;
  readBuffer(path: string): Promise<Buffer>;
  readLink(path: string): Promise<string>;
  readDirectory(path: string): Promise<Dirent[]>;
}

export interface ParsedProcStat {
  pid: number;
  name: string;
  state: LinuxProcessState;
  ppid: number;
  userCpuTicks: number;
  systemCpuTicks: number;
  cpuTimeTicks: number;
  startTimeTicks: number;
  virtualBytes: number;
}

export interface ParsedProcStatus {
  uid: number | null;
  rssBytes: number | null;
  virtualBytes: number | null;
  invalidFields: Array<"uid" | "rss" | "virtual_memory">;
}

interface SystemContext {
  totalMemoryBytes: number | null;
  uptimeSeconds: number | null;
  bootTimeSeconds: number | null;
  usernames: Map<number, string> | null;
  errors: ProcessInspectionError[];
}

interface ReadResult<T> {
  value: T | null;
  error?: ProcessInspectionError;
}

const PROCESS_STATES: Record<string, LinuxProcessState> = {
  R: "running",
  S: "sleeping",
  D: "uninterruptible_sleep",
  T: "stopped",
  t: "tracing_stop",
  Z: "zombie",
  X: "dead",
  x: "dead",
  K: "wakekill",
  W: "waking",
  P: "parked",
  I: "idle",
};

const SECRET_NAME = String.raw`(?:pass(?:word|wd)?|token|api[-_]?key|secret|credential|auth(?:orization)?|access[-_]?key)`;
const SECRET_ASSIGNMENT = new RegExp(`^(--?${SECRET_NAME}|${SECRET_NAME})(\\s*[=:]\\s*)(.*)$`, "i");
const SECRET_OPTION = new RegExp(`^--?${SECRET_NAME}$`, "i");
const NODE_FILESYSTEM: ProcessInspectorFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  readBuffer: (path) => readFile(path),
  readLink: (path) => readlink(path),
  readDirectory: (path) => readdir(path, { withFileTypes: true, encoding: "utf8" }),
};

export function parseProcStat(content: string, requestedPid: number): ParsedProcStat | null {
  const prefix = /^(\d+)\s+\(/.exec(content);
  const closingParen = content.lastIndexOf(")");
  if (!prefix || closingParen <= prefix[0].length - 2 || content[closingParen + 1] !== " ") return null;

  const pid = parseSafeInteger(prefix[1]);
  if (pid === null || pid !== requestedPid) return null;

  const name = content.slice(prefix[0].length, closingParen);
  const fields = content.slice(closingParen + 1).trim().split(/\s+/);
  if (!name || fields.length < 21 || !/^[A-Za-z]$/.test(fields[0] ?? "")) return null;

  const ppid = parseSafeInteger(fields[1]);
  const userCpuTicks = parseSafeInteger(fields[11]);
  const systemCpuTicks = parseSafeInteger(fields[12]);
  const startTimeTicks = parseSafeInteger(fields[19]);
  const virtualBytes = parseSafeInteger(fields[20]);
  if (ppid === null || userCpuTicks === null || systemCpuTicks === null || startTimeTicks === null || virtualBytes === null || virtualBytes < 0) {
    return null;
  }

  const cpuTimeTicks = userCpuTicks + systemCpuTicks;
  if (!Number.isSafeInteger(cpuTimeTicks)) return null;

  return {
    pid,
    name,
    state: PROCESS_STATES[fields[0]!] ?? "unknown",
    ppid,
    userCpuTicks,
    systemCpuTicks,
    cpuTimeTicks,
    startTimeTicks,
    virtualBytes,
  };
}

export function parseProcStatus(content: string): ParsedProcStatus {
  const values = new Map<string, string>();
  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator > 0) values.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }

  const invalidFields: ParsedProcStatus["invalidFields"] = [];
  const uidValues = values.get("Uid")?.split(/\s+/) ?? [];
  const uid = parseSafeInteger(uidValues[0]);
  if (uid === null) invalidFields.push("uid");

  const rssBytes = parseKilobytes(values.get("VmRSS"));
  if (rssBytes === null) invalidFields.push("rss");

  const virtualBytes = parseKilobytes(values.get("VmSize"));
  if (virtualBytes === null) invalidFields.push("virtual_memory");

  return { uid, rssBytes, virtualBytes, invalidFields };
}

export function redactCommandLine(args: string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const arg of args) {
    if (redactNext) {
      redacted.push("[REDACTED]");
      redactNext = false;
      continue;
    }

    const assignment = SECRET_ASSIGNMENT.exec(arg);
    if (assignment) {
      redacted.push(`${assignment[1]}${assignment[2]}[REDACTED]`);
    } else {
      redacted.push(arg);
      if (SECRET_OPTION.test(arg)) redactNext = true;
    }
  }

  return redacted;
}

export class ProcessInspector {
  private readonly procRoot: string;
  private readonly clockTicksPerSecond?: number;
  private readonly usernameResolver?: (uid: number) => Promise<string | null>;
  private readonly fileSystem: ProcessInspectorFileSystem;
  private readonly cpuSampler?: ProcessCpuSampler;

  constructor(options: ProcessInspectorOptions = {}) {
    this.procRoot = options.procRoot ?? "/proc";
    if (options.clockTicksPerSecond !== undefined &&
        (!Number.isSafeInteger(options.clockTicksPerSecond) || options.clockTicksPerSecond <= 0)) {
      throw new Error("clockTicksPerSecond must be a positive safe integer");
    }
    if (options.cpuSampler && options.cpuSampler.clockTicksPerSecond !== options.clockTicksPerSecond) {
      throw new Error("ProcessInspector and ProcessCpuSampler must use the same clockTicksPerSecond");
    }
    this.clockTicksPerSecond = options.clockTicksPerSecond;
    this.usernameResolver = options.resolveUsername;
    this.fileSystem = options.fileSystem ?? NODE_FILESYSTEM;
    this.cpuSampler = options.cpuSampler;
  }

  async listProcesses(): Promise<ProcessEnumerationResult> {
    const context = await this.readSystemContext();
    const processes: ProcessInfo[] = [];
    const errors = [...context.errors];
    let entries: Dirent[];

    try {
      entries = await this.fileSystem.readDirectory(this.procRoot);
    } catch (error) {
      errors.push(this.makeError(null, "proc_root", error, "Unable to read the proc filesystem"));
      return { processes, errors };
    }

    const pids = entries
      .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((pid) => Number.isSafeInteger(pid))
      .sort((left, right) => left - right);

    for (const pid of pids) {
      const result = await this.inspectProcess(pid, context);
      if (result.status === "found") processes.push(result.process);
      errors.push(...result.errors.filter((error) => error.pid !== null));
    }

    return { processes, errors };
  }

  async getProcessInfo(pid: number): Promise<ProcessInspectionResult> {
    if (!isValidPid(pid)) {
      return {
        status: "invalid_pid",
        pid,
        errors: [{ pid, field: "stat", reason: "malformed", message: "PID must be a positive safe integer" }],
      };
    }
    return this.inspectProcess(pid, await this.readSystemContext());
  }

  private async inspectProcess(pid: number, context: SystemContext): Promise<ProcessInspectionResult> {
    const statPath = join(this.procRoot, String(pid), "stat");
    const initialStat = await this.readText(statPath, pid, "stat", "Unable to read process stat");
    if (initialStat.value === null) return this.failureResult(pid, initialStat.error!);

    const parsedStat = parseProcStat(initialStat.value, pid);
    if (!parsedStat) {
      return this.failureResult(pid, {
        pid,
        field: "stat",
        reason: "malformed",
        message: "Process stat record is malformed or has an inconsistent PID",
      });
    }

    const errors: ProcessInspectionError[] = [];
    const [statusResult, commandLineResult, executableResult] = await Promise.all([
      this.readText(join(this.procRoot, String(pid), "status"), pid, "uid", "Unable to read process status"),
      this.readBuffer(join(this.procRoot, String(pid), "cmdline"), pid, "command_line", "Unable to read process command line"),
      this.readLink(join(this.procRoot, String(pid), "exe"), pid, "executable", "Unable to read process executable"),
    ]);

    for (const result of [statusResult, commandLineResult, executableResult]) {
      if (result.error) errors.push(result.error);
    }

    const status = statusResult.value === null ? null : parseProcStatus(statusResult.value);
    if (status) {
      for (const field of status.invalidFields) {
        errors.push({ pid, field, reason: "malformed", message: `Process status field ${field} is missing or malformed` });
      }
    }

    const commandLine = commandLineResult.value === null ? null : parseCommandLine(commandLineResult.value);
    let username: string | null = null;
    if (status?.uid !== null && status?.uid !== undefined) {
      username = await this.resolveUsername(status.uid, context, errors, pid);
    }

    const finalStat = await this.readText(statPath, pid, "stat", "Unable to revalidate process identity");
    if (finalStat.value === null) {
      const error = finalStat.error!;
      return this.failureResult(pid, error);
    }
    const finalParsedStat = parseProcStat(finalStat.value, pid);
    if (!finalParsedStat || finalParsedStat.startTimeTicks !== parsedStat.startTimeTicks) {
      return this.failureResult(pid, {
        pid,
        field: "stat",
        reason: "process_changed",
        message: "Process identity changed while it was being inspected",
      });
    }

    const rssBytes = status?.rssBytes ?? null;
    const memoryPercentage = rssBytes !== null && context.totalMemoryBytes !== null
      ? (rssBytes / context.totalMemoryBytes) * 100
      : null;
    const process: ProcessInfo = {
      pid,
      ppid: parsedStat.ppid,
      name: parsedStat.name,
      executable: executableResult.value,
      commandLine: commandLine === null ? null : redactCommandLine(commandLine),
      state: parsedStat.state,
      uid: status?.uid ?? null,
      username,
      memory: {
        rssBytes,
        virtualBytes: status?.virtualBytes ?? null,
        percentage: memoryPercentage !== null && Number.isFinite(memoryPercentage) ? memoryPercentage : null,
      },
      cpu: this.cpuSampler?.getCpuUsage({ pid, startTimeTicks: parsedStat.startTimeTicks }) ?? {
        available: false,
        reason: "sampling_not_started",
      },
      startTimeTicks: parsedStat.startTimeTicks,
      startTime: this.startTimestamp(parsedStat.startTimeTicks, context),
      elapsedSeconds: this.elapsedTime(parsedStat.startTimeTicks, context),
    };

    return { status: "found", process, errors: [...context.errors, ...errors] };
  }

  private async readSystemContext(): Promise<SystemContext> {
    const errors: ProcessInspectionError[] = [];
    const [meminfo, uptime, procStat, usernames] = await Promise.all([
      this.readText(join(this.procRoot, "meminfo"), null, "meminfo", "Unable to read system memory information"),
      this.readText(join(this.procRoot, "uptime"), null, "uptime", "Unable to read system uptime"),
      this.readText(join(this.procRoot, "stat"), null, "boot_time", "Unable to read system boot time"),
      this.readUsernames(),
    ]);

    for (const result of [meminfo, uptime, procStat, usernames]) {
      if (result.error) errors.push(result.error);
    }

    const totalMemoryBytes = meminfo.value === null ? null : parseMemTotal(meminfo.value);
    if (meminfo.value !== null && totalMemoryBytes === null) {
      errors.push({ pid: null, field: "meminfo", reason: "malformed", message: "MemTotal is missing or invalid" });
    }

    const uptimeSeconds = uptime.value === null ? null : parseUptime(uptime.value);
    if (uptime.value !== null && uptimeSeconds === null) {
      errors.push({ pid: null, field: "uptime", reason: "malformed", message: "System uptime is malformed" });
    }

    const bootTimeSeconds = procStat.value === null ? null : parseBootTime(procStat.value);
    if (procStat.value !== null && bootTimeSeconds === null) {
      errors.push({ pid: null, field: "boot_time", reason: "malformed", message: "System boot time is missing or invalid" });
    }

    if (this.clockTicksPerSecond === undefined) {
      errors.push({
        pid: null,
        field: "clock_tick_rate",
        reason: "unavailable",
        message: "CLK_TCK was not configured; derived process times are unavailable",
      });
    }

    return {
      totalMemoryBytes,
      uptimeSeconds,
      bootTimeSeconds,
      usernames: usernames.value,
      errors,
    };
  }

  private async readUsernames(): Promise<ReadResult<Map<number, string>>> {
    if (this.usernameResolver) return { value: null };
    try {
      const content = await this.fileSystem.readText("/etc/passwd");
      const usernames = new Map<number, string>();
      for (const line of content.split(/\r?\n/)) {
        const fields = line.split(":");
        const uid = parseSafeInteger(fields[2]);
        if (fields[0] && uid !== null) usernames.set(uid, fields[0]);
      }
      return { value: usernames };
    } catch (error) {
      return {
        value: null,
        error: this.makeError(null, "username", error, "Unable to read local account names"),
      };
    }
  }

  private async resolveUsername(
    uid: number,
    context: SystemContext,
    errors: ProcessInspectionError[],
    pid: number,
  ): Promise<string | null> {
    if (this.usernameResolver) {
      try {
        const username = await this.usernameResolver(uid);
        if (username !== null) return username;
      } catch {
        errors.push({ pid, field: "username", reason: "unavailable", message: "Username lookup failed" });
      }
    } else {
      const username = context.usernames?.get(uid);
      if (username) return username;
    }
    errors.push({ pid, field: "username", reason: "unavailable", message: "Username could not be resolved for this UID" });
    return null;
  }

  private startTimestamp(startTimeTicks: number, context: SystemContext): number | null {
    if (this.clockTicksPerSecond === undefined || context.bootTimeSeconds === null) return null;
    const timestamp = (context.bootTimeSeconds + startTimeTicks / this.clockTicksPerSecond) * 1_000;
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  private elapsedTime(startTimeTicks: number, context: SystemContext): number | null {
    if (this.clockTicksPerSecond === undefined || context.uptimeSeconds === null) return null;
    const elapsed = context.uptimeSeconds - startTimeTicks / this.clockTicksPerSecond;
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null;
  }

  private async readText(
    path: string,
    pid: number | null,
    field: ProcessInspectionField,
    message: string,
  ): Promise<ReadResult<string>> {
    try {
      return { value: await this.fileSystem.readText(path) };
    } catch (error) {
      return { value: null, error: this.makeError(pid, field, error, message) };
    }
  }

  private async readBuffer(
    path: string,
    pid: number,
    field: ProcessInspectionField,
    message: string,
  ): Promise<ReadResult<Buffer>> {
    try {
      return { value: await this.fileSystem.readBuffer(path) };
    } catch (error) {
      return { value: null, error: this.makeError(pid, field, error, message) };
    }
  }

  private async readLink(
    path: string,
    pid: number,
    field: ProcessInspectionField,
    message: string,
  ): Promise<ReadResult<string>> {
    try {
      return { value: await this.fileSystem.readLink(path) };
    } catch (error) {
      return { value: null, error: this.makeError(pid, field, error, message) };
    }
  }

  private makeError(
    pid: number | null,
    field: ProcessInspectionField,
    error: unknown,
    message: string,
  ): ProcessInspectionError {
    const code = errorCode(error);
    const reason: ProcessInspectionErrorReason = code === "ENOENT" || code === "ENOTDIR"
      ? pid !== null && field === "stat" ? "process_disappeared" : "unavailable"
      : code === "EACCES" || code === "EPERM"
        ? "access_denied"
        : code === undefined
          ? "malformed"
          : "unavailable";
    const detail = reason === "access_denied"
      ? "Access denied"
      : reason === "process_disappeared"
        ? "Process or proc entry disappeared"
        : message;
    return { pid, field, reason, message: detail };
  }

  private failureResult(pid: number, error: ProcessInspectionError): ProcessInspectionResult {
    const status = error.reason === "process_disappeared"
      ? "not_found"
      : error.reason === "access_denied"
        ? "access_denied"
        : error.reason === "process_changed"
          ? "process_changed"
          : "malformed";
    return { status, pid, errors: [error] };
  }
}

function parseCommandLine(buffer: Buffer): string[] | null {
  if (buffer.length === 0) return null;
  const args = buffer.toString("utf8").split("\0");
  if (args.at(-1) === "") args.pop();
  return args.length === 0 || args.every((arg) => arg.length === 0) ? null : args;
}

function parseMemTotal(content: string): number | null {
  const line = content.split(/\r?\n/).find((item) => item.startsWith("MemTotal:"));
  if (!line) return null;
  const totalBytes = parseKilobytes(line.slice("MemTotal:".length).trim());
  return totalBytes !== null && totalBytes > 0 ? totalBytes : null;
}

function parseUptime(content: string): number | null {
  const value = Number(content.trim().split(/\s+/)[0]);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseBootTime(content: string): number | null {
  const line = content.split(/\r?\n/).find((item) => item.startsWith("btime "));
  if (!line) return null;
  const value = parseSafeInteger(line.slice("btime ".length).trim());
  return value !== null && value > 0 ? value : null;
}

function parseKilobytes(value: string | undefined): number | null {
  if (!value) return null;
  const match = /^(\d+)\s+kB$/.exec(value);
  const kilobytes = parseSafeInteger(match?.[1]);
  if (kilobytes === null || kilobytes < 0) return null;
  const bytes = kilobytes * 1_024;
  return Number.isSafeInteger(bytes) ? bytes : null;
}

function parseSafeInteger(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}