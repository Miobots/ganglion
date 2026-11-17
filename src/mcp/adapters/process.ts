import type { ProcessCpuSampler } from "../process/process-cpu-sampler.ts";
import type { ProcessInspector } from "../process/process-inspector.ts";
import type { ProcessManager } from "../process/process-manager.ts";
import type {
  ProcessEnumerationResult,
  ProcessInfo,
  ProcessLaunchOptions,
  ProcessTerminationOptions,
  SupportedTerminationSignal,
} from "../process/types.ts";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";

export interface ProcessAdapterOptions {
  inspector: Pick<ProcessInspector, "listProcesses" | "getProcessInfo">;
  sampler: Pick<ProcessCpuSampler, "start" | "stop">;
  manager: Pick<ProcessManager, "startProcess" | "terminateProcess">;
  platform?: NodeJS.Platform;
}

export interface ProcessFindInput {
  name?: string;
  executable?: string;
  username?: string;
  pid?: number;
}

export interface ProcessFindResult {
  processes: ProcessInfo[];
  errors: ProcessEnumerationResult["errors"];
  count: number;
}

const EMPTY_OBJECT_SCHEMA: ToolSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

const PID_SCHEMA: ToolSchema = {
  type: "number",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "Positive process ID. Pass the identity returned by process.find for termination.",
};

export class ProcessAdapter implements CapabilityAdapter {
  readonly family = "confined_process" as const;
  private readonly inspector: ProcessAdapterOptions["inspector"];
  private readonly sampler: ProcessAdapterOptions["sampler"];
  private readonly manager: ProcessAdapterOptions["manager"];
  private readonly platform: NodeJS.Platform;

  constructor(options: ProcessAdapterOptions) {
    this.inspector = options.inspector;
    this.sampler = options.sampler;
    this.manager = options.manager;
    this.platform = options.platform ?? process.platform;
  }

  isAvailable(): boolean {
    return this.platform === "linux";
  }

  async start(): Promise<void> {
    await this.sampler.start();
  }

  async stop(): Promise<void> {
    await this.sampler.stop();
  }

  tools(): RegisteredTool[] {
    return [
      {
        name: "process.list",
        description: "List visible Linux processes with current memory in bytes and per-core CPU percentage (which may exceed 100%); CPU is unavailable until samples exist. Partial inspection failures are included. No environment variables are read.",
        inputSchema: EMPTY_OBJECT_SCHEMA,
        permission: "read",
        family: this.family,
        enabled: true,
        handler: async () => this.inspector.listProcesses(),
      },
      {
        name: "process.get_info",
        description: "Get normalized information for one visible Linux process, including memory in bytes and per-core CPU percentage when sampled. No environment variables are read.",
        inputSchema: objectSchema({ pid: PID_SCHEMA }, ["pid"]),
        permission: "read",
        family: this.family,
        enabled: true,
        handler: async (input) => {
          const pid = strictPid(asRecord(input)?.pid);
          return this.inspector.getProcessInfo(pid);
        },
      },
      {
        name: "process.find",
        description: "Find visible Linux processes by AND-combined filters. Name matching is case-insensitive partial matching; executable and username are exact matches. Returns every match with normalized CPU, memory, PID, and startTimeTicks identity. No environment variables are read.",
        inputSchema: objectSchema({
          name: { type: "string", minLength: 1, maxLength: 256 },
          executable: { type: "string", minLength: 1, maxLength: 4_096 },
          username: { type: "string", minLength: 1, maxLength: 256 },
          pid: PID_SCHEMA,
        }, []),
        permission: "read",
        family: this.family,
        enabled: true,
        handler: async (input) => this.findProcesses(input),
      },
      {
        name: "process.start",
        description: "Start an arbitrary executable path or name with argument-array semantics (no shell). This capability does not provide an OS sandbox or executable allowlist. Requires trusted action approval; raw arguments are not included in the approval request.",
        inputSchema: objectSchema({
          executable: { type: "string", minLength: 1, maxLength: 4_096 },
          args: { type: "array", maxItems: 256, items: { type: "string", maxLength: 16_384 } },
          cwd: { type: "string", minLength: 1, maxLength: 4_096 },
        }, ["executable"]),
        permission: "action",
        family: this.family,
        enabled: true,
        approvalRequest: async (input) => {
          const launch = validateLaunchInput(input);
          return {
            target: JSON.stringify({ executable: launch.executable, ...(launch.cwd ? { cwd: launch.cwd } : {}) }),
            reason: "Start arbitrary executable",
          };
        },
        handler: async (input) => this.manager.startProcess(validateLaunchInput(input)),
      },
      {
        name: "process.terminate",
        description: "Signal one specifically selected process using PID and startTimeTicks from process.find. Defaults to SIGTERM; SIGKILL is forceful and must be explicitly selected. Requires trusted action approval and revalidates protected-process policy and identity.",
        inputSchema: objectSchema({
          pid: PID_SCHEMA,
          startTimeTicks: { type: "number", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
          signal: { type: "string", enum: ["SIGTERM", "SIGKILL"] },
        }, ["pid", "startTimeTicks"]),
        permission: "action",
        family: this.family,
        enabled: true,
        approvalRequest: async (input) => {
          const termination = validateTerminationInput(input);
          let processName: string | null = null;
          try {
            const info = await this.inspector.getProcessInfo(termination.identity.pid);
            if (info.status === "found" && info.process.startTimeTicks === termination.identity.startTimeTicks) {
              processName = info.process.name;
            }
          } catch {
            processName = null;
          }
          const target = JSON.stringify({
            pid: termination.identity.pid,
            name: processName ? safeDisplayName(processName) : "unavailable",
            startTimeTicks: termination.identity.startTimeTicks,
            signal: termination.signal ?? "SIGTERM",
          });
          const reason = termination.signal === "SIGKILL"
            ? "Forcefully terminate selected process with SIGKILL"
            : "Terminate selected process with SIGTERM";
          return { target, reason };
        },
        handler: async (input) => this.manager.terminateProcess(validateTerminationInput(input)),
      },
    ];
  }

  private async findProcesses(input: unknown): Promise<ProcessFindResult> {
    const filters = validateFindInput(input);
    const enumeration = await this.inspector.listProcesses();
    const processes = enumeration.processes.filter((process) => {
      if (filters.name && !process.name.toLocaleLowerCase().includes(filters.name.toLocaleLowerCase())) return false;
      if (filters.executable && process.executable !== filters.executable) return false;
      if (filters.username && process.username !== filters.username) return false;
      if (filters.pid !== undefined && process.pid !== filters.pid) return false;
      return true;
    });
    return { processes, errors: enumeration.errors, count: processes.length };
  }
}

function objectSchema(properties: Record<string, ToolSchema>, required: string[]): ToolSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strictPid(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PID must be a positive safe integer");
  }
  return value;
}

function validateFindInput(value: unknown): ProcessFindInput {
  const input = asRecord(value);
  if (!input) throw new Error("Process filters must be an object");
  const allowed = new Set(["name", "executable", "username", "pid"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Unsupported process filter");
  const filters: ProcessFindInput = {};
  for (const key of ["name", "executable", "username"] as const) {
    const item = input[key];
    if (item === undefined) continue;
    if (typeof item !== "string" || item.trim().length === 0 || item.includes("\0")) {
      throw new Error(`Process filter ${key} must be a non-empty string without null bytes`);
    }
    filters[key] = item;
  }
  if (input.pid !== undefined) filters.pid = strictPid(input.pid);
  if (Object.keys(filters).length === 0) throw new Error("At least one process filter is required");
  return filters;
}

function validateLaunchInput(value: unknown): ProcessLaunchOptions {
  const input = asRecord(value);
  if (!input || Object.keys(input).some((key) => !["executable", "args", "cwd"].includes(key))) {
    throw new Error("Process start arguments are invalid");
  }
  if (typeof input.executable !== "string" || input.executable.trim().length === 0 || input.executable.includes("\0")) {
    throw new Error("Executable must be a non-empty string without null bytes");
  }
  if (input.args !== undefined && (!Array.isArray(input.args) || Array.from(input.args).some((arg) => typeof arg !== "string" || arg.includes("\0")))) {
    throw new Error("Arguments must be an array of strings without null bytes");
  }
  if (input.cwd !== undefined && (typeof input.cwd !== "string" || input.cwd.trim().length === 0 || input.cwd.includes("\0"))) {
    throw new Error("Working directory must be a non-empty string without null bytes");
  }
  return {
    executable: input.executable,
    ...(input.args === undefined ? {} : { args: input.args as string[] }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd as string }),
  };
}

function validateTerminationInput(value: unknown): ProcessTerminationOptions {
  const input = asRecord(value);
  if (!input || Object.keys(input).some((key) => !["pid", "startTimeTicks", "signal"].includes(key))) {
    throw new Error("Process termination arguments are invalid");
  }
  const pid = strictPid(input.pid);
  if (typeof input.startTimeTicks !== "number" || !Number.isSafeInteger(input.startTimeTicks) || input.startTimeTicks < 0) {
    throw new Error("startTimeTicks must be a non-negative safe integer");
  }
  if (input.signal !== undefined && input.signal !== "SIGTERM" && input.signal !== "SIGKILL") {
    throw new Error("Signal must be SIGTERM or SIGKILL");
  }
  const signal = input.signal as SupportedTerminationSignal | undefined;
  return {
    identity: { pid, startTimeTicks: input.startTimeTicks },
    ...(signal === undefined ? {} : { signal }),
  };
}

function safeDisplayName(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, "?").slice(0, 256);
}