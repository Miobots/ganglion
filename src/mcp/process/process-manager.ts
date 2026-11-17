import { ProcessInspector } from "./process-inspector.ts";
import type {
  ProcessIdentity,
  ProcessInspectionResult,
  ProcessManagementPolicy,
  ProcessManagerError,
  ProcessTerminationOptions,
  ProcessTerminationResult,
  SupportedTerminationSignal,
} from "./types.ts";

export interface ProcessManagerOptions {
  policy: ProcessManagementPolicy;
  procRoot?: string;
  inspector?: Pick<ProcessInspector, "getProcessInfo">;
  signalProcess?: (pid: number, signal: SupportedTerminationSignal) => boolean;
}

interface AncestorResult {
  pids?: Set<number>;
  error?: ProcessManagerError;
}

export class ProcessManager {
  private readonly policy: ProcessManagementPolicy;
  private readonly protectedPids: Set<number>;
  private readonly ganglionPid: number;
  private readonly inspector: Pick<ProcessInspector, "getProcessInfo">;
  private readonly signalProcess: (pid: number, signal: SupportedTerminationSignal) => boolean;

  constructor(options: ProcessManagerOptions) {
    if (!options.policy || typeof options.policy.enabled !== "boolean") {
      throw new Error("ProcessManager requires an explicit process management policy");
    }
    const protectedPids = options.policy.protectedPids ?? [];
    if (!Array.isArray(protectedPids) || protectedPids.some((pid) => !isValidPid(pid))) {
      throw new Error("Process policy protectedPids must contain positive safe integer PIDs");
    }
    const ganglionPid = options.policy.ganglionPid ?? process.pid;
    if (!isValidPid(ganglionPid)) throw new Error("Process policy ganglionPid must be a positive safe integer");

    this.policy = { ...options.policy, protectedPids: [...protectedPids], ganglionPid };
    this.protectedPids = new Set([1, ganglionPid, ...protectedPids]);
    this.ganglionPid = ganglionPid;
    this.inspector = options.inspector ?? new ProcessInspector({ procRoot: options.procRoot });
    this.signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  }

  async terminateProcess(options: ProcessTerminationOptions): Promise<ProcessTerminationResult> {
    const input = asRecord(options);
    const identityInput = asRecord(input?.identity);
    const identityPid = identityInput?.pid;
    const identityStartTimeTicks = identityInput?.startTimeTicks;
    const signalValue = input?.signal;
    const signal = signalValue === undefined ? "SIGTERM" : isSupportedSignal(signalValue) ? signalValue : null;
    const pid = typeof identityPid === "number" ? identityPid : null;

    if (!this.policy.enabled) return this.terminationFailure("disabled", pid, signal, "process_management_disabled", "Process management is disabled");
    if (!identityInput) return this.terminationFailure("invalid_identity", pid, signal, "invalid_identity", "Expected process identity is required");
    if (!isValidPid(identityPid)) return this.terminationFailure("invalid_pid", pid, signal, "invalid_pid", "PID must be a positive safe integer");
    if (typeof identityStartTimeTicks !== "number" || !Number.isSafeInteger(identityStartTimeTicks) || identityStartTimeTicks < 0) {
      return this.terminationFailure("invalid_identity", identityPid, signal, "invalid_identity", "Expected process start-time ticks are invalid");
    }
    if (signal === null) return this.terminationFailure("invalid_signal", identityPid, null, "invalid_signal", "Only SIGTERM and SIGKILL are supported");

    const identity: ProcessIdentity = { pid: identityPid, startTimeTicks: identityStartTimeTicks };

    if (this.protectedPids.has(identity.pid)) {
      return this.terminationFailure("protected_process", identity.pid, signal, "protected_process", "Process is protected by policy");
    }

    const ancestors = await this.findGanglionAncestors();
    if (!ancestors.pids) {
      return this.terminationFailure(
        "protection_check_failed",
        identity.pid,
        signal,
        ancestors.error?.code ?? "protection_check_failed",
        ancestors.error?.message ?? "Unable to verify protected ancestor processes",
      );
    }
    if (ancestors.pids.has(identity.pid)) {
      return this.terminationFailure("protected_process", identity.pid, signal, "protected_process", "Process is an ancestor of Ganglion");
    }

    let current: ProcessInspectionResult;
    try {
      current = await this.inspector.getProcessInfo(identity.pid);
    } catch {
      return this.terminationFailure("access_denied", identity.pid, signal, "inspection_failed", "Unable to verify current process identity");
    }
    if (current.status !== "found") {
      if (current.status === "not_found" || current.status === "invalid_pid") {
        return this.terminationFailure("not_found", identity.pid, signal, "process_not_found", "Process does not exist or has already exited");
      }
      if (current.status === "access_denied") {
        return this.terminationFailure("access_denied", identity.pid, signal, "access_denied", "Access to process identity was denied");
      }
      return this.terminationFailure("identity_mismatch", identity.pid, signal, "identity_unavailable", "Current process identity could not be verified");
    }
    if (current.process.startTimeTicks !== identity.startTimeTicks) {
      return this.terminationFailure("identity_mismatch", identity.pid, signal, "identity_mismatch", "PID now refers to a different process");
    }

    try {
      const signalSent = this.signalProcess(identity.pid, signal);
      if (!signalSent) {
        return this.terminationFailure("signal_error", identity.pid, signal, "signal_not_sent", "Operating system did not send the requested signal");
      }
      return { status: "signalled", pid: identity.pid, signal, signalSent: true, error: null };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ESRCH") {
        return this.terminationFailure("not_found", identity.pid, signal, "process_not_found", "Process exited before the signal was sent");
      }
      if (code === "EPERM" || code === "EACCES") {
        return this.terminationFailure("permission_denied", identity.pid, signal, "permission_denied", "Operating system denied the signal");
      }
      return this.terminationFailure("signal_error", identity.pid, signal, "signal_error", "Operating system could not send the requested signal");
    }
  }

  private async findGanglionAncestors(): Promise<AncestorResult> {
    const ancestors = new Set<number>();
    const visited = new Set<number>();
    let currentPid = this.ganglionPid;

    while (currentPid > 1 && visited.size < 4_096) {
      if (visited.has(currentPid)) {
        return { error: { code: "ancestor_cycle", message: "Ganglion ancestor chain is inconsistent" } };
      }
      visited.add(currentPid);

      let result: ProcessInspectionResult;
      try {
        result = await this.inspector.getProcessInfo(currentPid);
      } catch {
        return { error: { code: "ancestor_unavailable", message: "Unable to inspect Ganglion ancestor chain" } };
      }
      if (result.status !== "found") {
        return { error: { code: "ancestor_unavailable", message: "Unable to verify Ganglion ancestor chain" } };
      }

      const parentPid = result.process.ppid;
      if (!Number.isSafeInteger(parentPid) || parentPid < 0) {
        return { error: { code: "ancestor_malformed", message: "Ganglion ancestor data is malformed" } };
      }
      if (parentPid === 0) break;
      ancestors.add(parentPid);
      if (parentPid === 1) break;
      currentPid = parentPid;
    }

    if (visited.size >= 4_096) {
      return { error: { code: "ancestor_depth_exceeded", message: "Ganglion ancestor chain exceeded the safety limit" } };
    }
    return { pids: ancestors };
  }

  private terminationFailure(
    status: ProcessTerminationResult["status"],
    pid: number | null,
    signal: SupportedTerminationSignal | null,
    code: string,
    message: string,
  ): ProcessTerminationResult {
    return { status, pid, signal, signalSent: false, error: { code, message } };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;
}

function isSupportedSignal(value: unknown): value is SupportedTerminationSignal {
  return value === "SIGTERM" || value === "SIGKILL";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}