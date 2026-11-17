import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { parseProcStat, type ProcessInspectorFileSystem } from "./process-inspector.ts";
import type { CpuUsage, ProcessIdentity } from "./types.ts";

export interface ProcessCpuSamplerOptions {
  procRoot?: string;
  clockTicksPerSecond?: number;
  /** Sampling period in milliseconds; defaults to 1000. */
  intervalMs?: number;
  clock?: () => number;
  fileSystem?: ProcessCpuSamplerFileSystem;
  timer?: ProcessCpuSamplerTimer;
}

export type ProcessCpuSamplerFileSystem = Pick<ProcessInspectorFileSystem, "readText" | "readDirectory">;

export interface ProcessCpuSamplerTimerHandle {
  unref?: () => void;
}

export interface ProcessCpuSamplerTimer {
  setInterval(callback: () => void, intervalMs: number): ProcessCpuSamplerTimerHandle;
  clearInterval(handle: ProcessCpuSamplerTimerHandle): void;
}

interface RawCpuSample {
  pid: number;
  startTimeTicks: number;
  cpuTimeTicks: number;
  sampledAt: number;
}

interface ProcessCpuMeasurement {
  startTimeTicks: number;
  usage: CpuUsage;
}

const NODE_FILESYSTEM: ProcessCpuSamplerFileSystem = {
  readText: (path) => readFile(path, "utf8"),
  readDirectory: (path) => readdir(path, { withFileTypes: true, encoding: "utf8" }),
};

const NODE_TIMER: ProcessCpuSamplerTimer = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export class ProcessCpuSampler {
  readonly clockTicksPerSecond?: number;

  private readonly procRoot: string;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly fileSystem: ProcessCpuSamplerFileSystem;
  private readonly timer: ProcessCpuSamplerTimer;
  private baselines = new Map<number, RawCpuSample>();
  private latest = new Map<number, ProcessCpuMeasurement>();
  private readonly seenPids = new Set<number>();
  private interval?: ProcessCpuSamplerTimerHandle;
  private inFlight?: Promise<void>;
  private running = false;
  private hasCompletedSample = false;

  constructor(options: ProcessCpuSamplerOptions = {}) {
    if (options.clockTicksPerSecond !== undefined &&
        (!Number.isSafeInteger(options.clockTicksPerSecond) || options.clockTicksPerSecond <= 0)) {
      throw new Error("clockTicksPerSecond must be a positive safe integer");
    }
    const intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("intervalMs must be a positive safe integer");
    }

    this.clockTicksPerSecond = options.clockTicksPerSecond;
    this.procRoot = options.procRoot ?? "/proc";
    this.intervalMs = intervalMs;
    this.clock = options.clock ?? (() => performance.now());
    this.fileSystem = options.fileSystem ?? NODE_FILESYSTEM;
    this.timer = options.timer ?? NODE_TIMER;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.baselines.clear();
    this.latest.clear();
    this.seenPids.clear();
    this.hasCompletedSample = false;

    await this.sampleNow();
    if (!this.running) return;

    this.interval = this.timer.setInterval(() => {
      void this.sampleNow();
    }, this.intervalMs);
    this.interval.unref?.();
  }

  async stop(): Promise<void> {
    if (!this.running && !this.interval) {
      await this.inFlight;
      return;
    }
    this.running = false;
    if (this.interval) {
      this.timer.clearInterval(this.interval);
      this.interval = undefined;
    }
    await this.inFlight;
  }

  sampleNow(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const cycle = this.collectSafely().finally(() => {
      if (this.inFlight === cycle) this.inFlight = undefined;
    });
    this.inFlight = cycle;
    return cycle;
  }

  getCpuUsage(identity: ProcessIdentity): CpuUsage {
    if (this.clockTicksPerSecond === undefined) {
      return { available: false, reason: "clock_tick_rate_unavailable" };
    }

    const measurement = this.latest.get(identity.pid);
    if (measurement?.startTimeTicks === identity.startTimeTicks) return measurement.usage;
    if (measurement || this.seenPids.has(identity.pid)) {
      return { available: false, reason: "process_unreadable" };
    }
    if (this.running || this.hasCompletedSample) {
      return { available: false, reason: "insufficient_sampling_data" };
    }
    return { available: false, reason: "sampling_not_started" };
  }

  private async collectSafely(): Promise<void> {
    try {
      await this.collect();
    } catch {
      this.baselines.clear();
      this.latest.clear();
      this.hasCompletedSample = true;
    }
  }

  private async collect(): Promise<void> {
    const entries = await this.fileSystem.readDirectory(this.procRoot);
    const pids = entries
      .filter((entry) => entry.isDirectory() && /^[1-9]\d*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((pid) => Number.isSafeInteger(pid))
      .sort((left, right) => left - right);
    const current = new Map<number, RawCpuSample>();
    const measurements = new Map<number, ProcessCpuMeasurement>();

    for (const pid of pids) {
      this.seenPids.add(pid);
      let content: string;
      try {
        content = await this.fileSystem.readText(join(this.procRoot, String(pid), "stat"));
      } catch {
        continue;
      }

      const parsed = parseProcStat(content, pid);
      const sampledAt = this.clock();
      if (!parsed || !Number.isFinite(sampledAt)) continue;

      const sample: RawCpuSample = {
        pid,
        startTimeTicks: parsed.startTimeTicks,
        cpuTimeTicks: parsed.cpuTimeTicks,
        sampledAt,
      };
      const previous = this.baselines.get(pid);
      const usage = this.calculateUsage(previous, sample);
      current.set(pid, sample);
      measurements.set(pid, { startTimeTicks: parsed.startTimeTicks, usage });
    }

    this.baselines = current;
    this.latest = measurements;
    this.hasCompletedSample = true;
  }

  private calculateUsage(previous: RawCpuSample | undefined, current: RawCpuSample): CpuUsage {
    if (this.clockTicksPerSecond === undefined) {
      return { available: false, reason: "clock_tick_rate_unavailable" };
    }
    if (!previous || previous.startTimeTicks !== current.startTimeTicks) {
      return { available: false, reason: "insufficient_sampling_data" };
    }

    const deltaTicks = current.cpuTimeTicks - previous.cpuTimeTicks;
    const elapsedSeconds = (current.sampledAt - previous.sampledAt) / 1_000;
    if (!Number.isFinite(deltaTicks) || deltaTicks < 0 || !Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
      return { available: false, reason: "insufficient_sampling_data" };
    }

    // Per-core percentage: 100% is one logical CPU; do not normalize by CPU count.
    const percentage = (deltaTicks / this.clockTicksPerSecond / elapsedSeconds) * 100;
    if (!Number.isFinite(percentage) || percentage < 0) {
      return { available: false, reason: "insufficient_sampling_data" };
    }
    return { available: true, percentage };
  }
}