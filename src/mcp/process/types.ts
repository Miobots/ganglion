export type LinuxProcessState =
  | "running"
  | "sleeping"
  | "uninterruptible_sleep"
  | "stopped"
  | "tracing_stop"
  | "zombie"
  | "dead"
  | "wakekill"
  | "waking"
  | "parked"
  | "idle"
  | "unknown";

export interface ProcessMemory {
  rssBytes: number | null;
  virtualBytes: number | null;
  percentage: number | null;
}

export type CpuUsage =
  | { available: true; percentage: number }
  | {
      available: false;
      reason: "sampling_not_started" | "insufficient_sampling_data" | "process_unreadable" | "clock_tick_rate_unavailable";
    };

export interface ProcessIdentity {
  pid: number;
  startTimeTicks: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  executable: string | null;
  commandLine: string[] | null;
  state: LinuxProcessState;
  uid: number | null;
  username: string | null;
  memory: ProcessMemory;
  cpu: CpuUsage;
  startTimeTicks: number;
  startTime: number | null;
  elapsedSeconds: number | null;
}

export type ProcessInspectionField =
  | "proc_root"
  | "stat"
  | "uid"
  | "rss"
  | "virtual_memory"
  | "command_line"
  | "executable"
  | "meminfo"
  | "uptime"
  | "boot_time"
  | "clock_tick_rate"
  | "username";

export type ProcessInspectionErrorReason =
  | "process_disappeared"
  | "access_denied"
  | "malformed"
  | "unavailable"
  | "process_changed";

export interface ProcessInspectionError {
  pid: number | null;
  field: ProcessInspectionField;
  reason: ProcessInspectionErrorReason;
  message: string;
}

export type ProcessInspectionResult =
  | { status: "found"; process: ProcessInfo; errors: ProcessInspectionError[] }
  | {
      status: "invalid_pid" | "not_found" | "access_denied" | "malformed" | "process_changed";
      pid: number;
      errors: ProcessInspectionError[];
    };

export interface ProcessEnumerationResult {
  processes: ProcessInfo[];
  errors: ProcessInspectionError[];
}

export interface ProcessLaunchOptions {
  executable: string;
  args?: string[];
  cwd?: string;
}

export type SupportedTerminationSignal = "SIGTERM" | "SIGKILL";

export interface ProcessTerminationOptions {
  identity: ProcessIdentity;
  signal?: SupportedTerminationSignal;
}

export interface ProcessManagementPolicy {
  enabled: boolean;
  protectedPids?: number[];
  ganglionPid?: number;
}

export interface ProcessManagementConfiguration extends ProcessManagementPolicy {
  clockTicksPerSecond?: number;
  sampleIntervalMs?: number;
}

export interface ProcessManagerError {
  code: string;
  message: string;
}

export interface ProcessStartResult {
  status: "started" | "disabled" | "failed";
  pid: number | null;
  executable: string | null;
  workingDirectory: string | null;
  error: ProcessManagerError | null;
}

export type ProcessTerminationStatus =
  | "signalled"
  | "disabled"
  | "invalid_pid"
  | "invalid_identity"
  | "invalid_signal"
  | "not_found"
  | "access_denied"
  | "identity_mismatch"
  | "protected_process"
  | "protection_check_failed"
  | "permission_denied"
  | "signal_error";

export interface ProcessTerminationResult {
  status: ProcessTerminationStatus;
  pid: number | null;
  signal: SupportedTerminationSignal | null;
  signalSent: boolean;
  error: ProcessManagerError | null;
}