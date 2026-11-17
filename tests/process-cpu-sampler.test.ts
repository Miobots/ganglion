import { afterEach, describe, expect, it } from "bun:test";
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessCpuSampler, type ProcessCpuSamplerFileSystem, type ProcessCpuSamplerTimer, type ProcessCpuSamplerTimerHandle } from "../src/mcp/process/process-cpu-sampler.ts";
import type { ProcessIdentity } from "../src/mcp/process/types.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProcessCpuSampler", () => {
  it("reports an unavailable first sample and calculates 100% per-core usage on the next sample", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    let now = 0;
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now });
    const identity = { pid: 42, startTimeTicks: 500 };

    await sampler.sampleNow();
    expect(sampler.getCpuUsage(identity)).toEqual({ available: false, reason: "insufficient_sampling_data" });
    now = 1_000;
    await writeProcessStat(procRoot, 42, 100, 0, 500);
    await sampler.sampleNow();

    expect(sampler.getCpuUsage(identity)).toEqual({ available: true, percentage: 100 });
  });

  it("reports 200% when two core-equivalents are consumed", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    let now = 0;
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now });
    const identity = { pid: 42, startTimeTicks: 500 };
    await sampler.sampleNow();
    now = 1_000;
    await writeProcessStat(procRoot, 42, 200, 0, 500);
    await sampler.sampleNow();

    expect(sampler.getCpuUsage(identity)).toEqual({ available: true, percentage: 200 });
  });

  it("reports zero for an idle process", async () => {
    const procRoot = await createProcFixture(30, 20, 500);
    let now = 10;
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now });
    await sampler.sampleNow();
    now = 1_010;
    await sampler.sampleNow();

    expect(sampler.getCpuUsage({ pid: 42, startTimeTicks: 500 })).toEqual({ available: true, percentage: 0 });
  });

  it("rejects negative CPU deltas and zero elapsed time without fabricating a value", async () => {
    const procRoot = await createProcFixture(50, 0, 500);
    let now = 1_000;
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now });
    const identity = { pid: 42, startTimeTicks: 500 };
    await sampler.sampleNow();

    await writeProcessStat(procRoot, 42, 40, 0, 500);
    await sampler.sampleNow();
    expect(sampler.getCpuUsage(identity)).toEqual({ available: false, reason: "insufficient_sampling_data" });

    now = 2_000;
    await sampler.sampleNow();
    expect(sampler.getCpuUsage(identity)).toEqual({ available: true, percentage: 0 });

    await writeProcessStat(procRoot, 42, 60, 0, 500);
    await sampler.sampleNow();
    expect(sampler.getCpuUsage(identity)).toEqual({ available: false, reason: "insufficient_sampling_data" });
  });

  it("clears measurements when a process is missing or disappears between cycles", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    let now = 0;
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now });
    const identity = { pid: 42, startTimeTicks: 500 };
    await sampler.sampleNow();
    now = 1_000;
    await writeProcessStat(procRoot, 42, 100, 0, 500);
    await sampler.sampleNow();
    expect(sampler.getCpuUsage(identity)).toEqual({ available: true, percentage: 100 });

    await rm(join(procRoot, "42"), { recursive: true });
    now = 2_000;
    await sampler.sampleNow();
    expect(sampler.getCpuUsage(identity)).toEqual({ available: false, reason: "process_unreadable" });
  });

  it("reports a visible process with an unreadable stat file as unavailable", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    const fileSystem = createFileSystem({ readText: async (path) => {
      if (path === join(procRoot, "42", "stat")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return readFile(path, "utf8");
    } });
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, fileSystem });
    await sampler.sampleNow();

    expect(sampler.getCpuUsage({ pid: 42, startTimeTicks: 500 })).toEqual({
      available: false,
      reason: "process_unreadable",
    });
  });

  it("treats a reused PID as a new baseline and rejects the old identity", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    let now = 0;
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now });
    const oldIdentity = { pid: 42, startTimeTicks: 500 };
    const newIdentity = { pid: 42, startTimeTicks: 900 };
    await sampler.sampleNow();
    now = 1_000;
    await writeProcessStat(procRoot, 42, 100, 0, 900);
    await sampler.sampleNow();

    expect(sampler.getCpuUsage(oldIdentity)).toEqual({ available: false, reason: "process_unreadable" });
    expect(sampler.getCpuUsage(newIdentity)).toEqual({ available: false, reason: "insufficient_sampling_data" });

    now = 2_000;
    await writeProcessStat(procRoot, 42, 200, 0, 900);
    await sampler.sampleNow();
    expect(sampler.getCpuUsage(newIdentity)).toEqual({ available: true, percentage: 100 });
  });

  it("validates the tick rate and returns unavailable when it is not configured", async () => {
    expect(() => new ProcessCpuSampler({ clockTicksPerSecond: 0 })).toThrow(/clockTicksPerSecond/);
    expect(() => new ProcessCpuSampler({ clockTicksPerSecond: -1 })).toThrow(/clockTicksPerSecond/);
    const sampler = new ProcessCpuSampler();
    expect(sampler.getCpuUsage({ pid: 42, startTimeTicks: 500 })).toEqual({
      available: false,
      reason: "clock_tick_rate_unavailable",
    });
  });

  it("starts one unref'ed timer and stops it cleanly", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    const timer = new FakeTimer();
    let directoryReads = 0;
    const fileSystem = createFileSystem({ readDirectory: async (path) => { directoryReads++; return readdir(path, { withFileTypes: true, encoding: "utf8" }); } });
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, timer, fileSystem });

    expect(sampler.isRunning()).toBe(false);
    await sampler.start();
    expect(sampler.isRunning()).toBe(true);
    expect(directoryReads).toBe(1);
    expect(timer.intervalMs).toBe(1_000);
    expect(timer.unrefCalls).toBe(1);

    await sampler.start();
    expect(directoryReads).toBe(1);
    expect(timer.setCalls).toBe(1);
    await sampler.stop();
    expect(sampler.isRunning()).toBe(false);
    expect(timer.clearCalls).toBe(1);
  });

  it("does not overlap sampling cycles", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    let readStarted!: () => void;
    let releaseRead!: () => void;
    const started = new Promise<void>((resolve) => { readStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseRead = resolve; });
    let directoryReads = 0;
    const fileSystem = createFileSystem({
      readDirectory: async (path) => {
        directoryReads++;
        readStarted();
        await blocked;
        return readdir(path, { withFileTypes: true, encoding: "utf8" });
      },
    });
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, fileSystem });
    const first = sampler.sampleNow();
    await started;
    const second = sampler.sampleNow();
    expect(directoryReads).toBe(1);
    releaseRead();
    await Promise.all([first, second]);
    expect(directoryReads).toBe(1);
  });

  it("contains sampling failures without stopping the sampler", async () => {
    const procRoot = await createProcFixture(0, 0, 500);
    const timer = new FakeTimer();
    let fail = true;
    const fileSystem = createFileSystem({
      readDirectory: async (path) => {
        if (fail) throw new Error("temporary proc failure");
        return readdir(path, { withFileTypes: true, encoding: "utf8" });
      },
    });
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, timer, fileSystem });

    await expect(sampler.start()).resolves.toBeUndefined();
    expect(sampler.isRunning()).toBe(true);
    fail = false;
    timer.trigger();
    await sampler.sampleNow();
    expect(sampler.isRunning()).toBe(true);
    await sampler.stop();
  });
});

class FakeTimer implements ProcessCpuSamplerTimer {
  intervalMs?: number;
  setCalls = 0;
  clearCalls = 0;
  unrefCalls = 0;
  private callback?: () => void;
  private handle?: ProcessCpuSamplerTimerHandle;

  setInterval(callback: () => void, intervalMs: number): ProcessCpuSamplerTimerHandle {
    this.callback = callback;
    this.intervalMs = intervalMs;
    this.setCalls++;
    this.handle = { unref: () => { this.unrefCalls++; } };
    return this.handle;
  }

  clearInterval(handle: ProcessCpuSamplerTimerHandle): void {
    expect(handle).toBe(this.handle);
    this.clearCalls++;
    this.callback = undefined;
  }

  trigger(): void {
    this.callback?.();
  }
}

async function createProcFixture(userCpuTicks: number, systemCpuTicks: number, startTimeTicks: number): Promise<string> {
  const procRoot = await mkdtemp(join(tmpdir(), "ganglion-cpu-fixture-"));
  temporaryDirectories.push(procRoot);
  await writeProcessStat(procRoot, 42, userCpuTicks, systemCpuTicks, startTimeTicks);
  return procRoot;
}

async function writeProcessStat(
  procRoot: string,
  pid: number,
  userCpuTicks: number,
  systemCpuTicks: number,
  startTimeTicks: number,
): Promise<void> {
  const directory = join(procRoot, String(pid));
  await mkdir(directory, { recursive: true });
  const fields = Array.from({ length: 21 }, () => "0");
  fields[0] = "S";
  fields[1] = "1";
  fields[11] = String(userCpuTicks);
  fields[12] = String(systemCpuTicks);
  fields[13] = "100000";
  fields[14] = "200000";
  fields[19] = String(startTimeTicks);
  fields[20] = "4096";
  await writeFile(join(directory, "stat"), `${pid} (cpu-fixture) ${fields.join(" ")}\n`);
}

function createFileSystem(overrides: Partial<ProcessCpuSamplerFileSystem> = {}): ProcessCpuSamplerFileSystem {
  return {
    readText: (path) => readFile(path, "utf8"),
    readDirectory: (path) => readdir(path, { withFileTypes: true, encoding: "utf8" }),
    ...overrides,
  };
}