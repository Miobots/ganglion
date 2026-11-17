import { afterEach, describe, expect, it } from "bun:test";
import { readFile, readdir, readlink, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessCpuSampler } from "../src/mcp/process/process-cpu-sampler.ts";
import { ProcessInspector, parseProcStat, parseProcStatus, redactCommandLine, type ProcessInspectorFileSystem } from "../src/mcp/process/process-inspector.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ProcessInspector", () => {
  it("parses stat records with spaces and parentheses in the process name", () => {
    const parsed = parseProcStat(statRecord(42, "worker (pool) one", "S", 7, 1234), 42);
    expect(parsed).toMatchObject({
      pid: 42,
      name: "worker (pool) one",
      state: "sleeping",
      ppid: 7,
      userCpuTicks: 14,
      systemCpuTicks: 15,
      cpuTimeTicks: 29,
      startTimeTicks: 1234,
    });
  });

  it("rejects malformed stat content and PID mismatches", () => {
    expect(parseProcStat("not a stat record", 42)).toBeNull();
    expect(parseProcStat(statRecord(41, "other", "R", 1, 10), 42)).toBeNull();
  });

  it("parses UID and converts RSS and virtual memory from kB to bytes", () => {
    expect(parseProcStatus("Name:\tworker\nUid:\t1001\t1001\t1001\t1001\nVmRSS:\t12 kB\nVmSize:\t80 kB\n"))
      .toEqual({ uid: 1001, rssBytes: 12_288, virtualBytes: 81_920, invalidFields: [] });
  });

  it("reports missing or malformed status values as unavailable", () => {
    expect(parseProcStatus("Uid:\tbad\nVmRSS:\t-3 kB\nVmSize:\t1 MB\n"))
      .toEqual({ uid: null, rssBytes: null, virtualBytes: null, invalidFields: ["uid", "rss", "virtual_memory"] });
  });

  it("returns command arguments with obvious secret assignments redacted", () => {
    expect(redactCommandLine([
      "/usr/bin/demo",
      "--password=hunter2",
      "--token",
      "abc123",
      "API_KEY=key-value",
      "--api-key = spaced-key",
      "--mode=safe",
    ])).toEqual([
      "/usr/bin/demo",
      "--password=[REDACTED]",
      "--token",
      "[REDACTED]",
      "API_KEY=[REDACTED]",
      "--api-key = [REDACTED]",
      "--mode=safe",
    ]);
  });

  it("inspects memory, identity, command line and executable from fixture proc data", async () => {
    const procRoot = await createProcFixture();
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async (uid) => uid === 1000 ? "fixture-user" : null });
    const result = await inspector.getProcessInfo(42);

    expect(result.status).toBe("found");
    if (result.status !== "found") return;
    expect(result.process).toMatchObject({
      pid: 42,
      ppid: 7,
      name: "worker (pool) one",
      executable: "/usr/bin/fixture-worker",
      commandLine: ["/usr/bin/fixture-worker", "--password=[REDACTED]", "--mode", "safe"],
      state: "sleeping",
      uid: 1000,
      username: "fixture-user",
      memory: { rssBytes: 2_048_000, virtualBytes: 8_192_000, percentage: 2 },
      cpu: { available: false, reason: "sampling_not_started" },
      startTimeTicks: 500,
      startTime: 1_700_000_005_000,
      elapsedSeconds: 95,
    });
    expect(result.errors).toEqual([]);
  });

  it("refreshes RSS, virtual memory, and percentage on every inspection", async () => {
    const procRoot = await createProcFixture();
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user" });
    const first = await inspector.getProcessInfo(42);
    expect(first.status).toBe("found");
    if (first.status !== "found") return;
    expect(first.process.memory).toEqual({ rssBytes: 2_048_000, virtualBytes: 8_192_000, percentage: 2 });

    await writeFile(join(procRoot, "42", "status"), "Uid:\t1000\t1000\t1000\t1000\nVmRSS:\t3000 kB\nVmSize:\t9000 kB\n");
    await writeFile(join(procRoot, "meminfo"), "MemTotal: 200000 kB\n");
    const second = await inspector.getProcessInfo(42);

    expect(second.status).toBe("found");
    if (second.status === "found") {
      expect(second.process.memory).toEqual({ rssBytes: 3_072_000, virtualBytes: 9_216_000, percentage: 1.5 });
    }
  });

  it("returns the latest CPU measurement only for the inspected process identity", async () => {
    const procRoot = await createProcFixture();
    let now = 0;
    const fileSystem = createFileSystem();
    const sampler = new ProcessCpuSampler({ procRoot, clockTicksPerSecond: 100, clock: () => now, fileSystem });
    await sampler.sampleNow();
    now = 1_000;
    await writeFile(join(procRoot, "42", "stat"), statRecord(42, "worker (pool) one", "S", 7, 500, 114, 15));
    await sampler.sampleNow();
    const inspector = new ProcessInspector({
      procRoot,
      clockTicksPerSecond: 100,
      resolveUsername: async () => "fixture-user",
      fileSystem,
      cpuSampler: sampler,
    });
    const result = await inspector.getProcessInfo(42);

    expect(result.status).toBe("found");
    if (result.status === "found") expect(result.process.cpu).toEqual({ available: true, percentage: 100 });
    expect(() => new ProcessInspector({ procRoot, clockTicksPerSecond: 200, cpuSampler: sampler })).toThrow(/same clockTicksPerSecond/);
  });

  it("returns null for empty or unavailable command lines and missing executable links", async () => {
    const procRoot = await createProcFixture();
    await writeFile(join(procRoot, "42", "cmdline"), Buffer.alloc(0));
    await rm(join(procRoot, "42", "exe"));
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user" });
    const result = await inspector.getProcessInfo(42);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.process.commandLine).toBeNull();
      expect(result.process.executable).toBeNull();
      expect(result.errors.map((error) => error.field)).toContain("executable");
    }
  });

  it("returns an unavailable command line when its proc entry cannot be read", async () => {
    const procRoot = await createProcFixture();
    await rm(join(procRoot, "42", "cmdline"));
    await mkdir(join(procRoot, "42", "cmdline"));
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user" });
    const result = await inspector.getProcessInfo(42);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.process.commandLine).toBeNull();
      expect(result.errors).toContainEqual(expect.objectContaining({ field: "command_line" }));
    }
  });

  it("enumerates numeric process directories and reports malformed and disappearing entries", async () => {
    const procRoot = await createProcFixture();
    await writeProcess(procRoot, 43, { stat: "broken", status: "", cmdline: "", executable: null });
    await mkdir(join(procRoot, "44"));
    await mkdir(join(procRoot, "not-a-pid"));
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user" });
    const result = await inspector.listProcesses();

    expect(result.processes.map((process) => process.pid)).toEqual([42]);
    expect(result.errors).toContainEqual(expect.objectContaining({ pid: 43, field: "stat", reason: "malformed" }));
    expect(result.errors).toContainEqual(expect.objectContaining({ pid: 44, field: "stat", reason: "process_disappeared" }));
    expect(result.errors.some((error) => error.pid === null && error.field === "proc_root")).toBe(false);
  });

  it("includes multiple valid processes in numeric PID order", async () => {
    const procRoot = await createProcFixture();
    await writeProcess(procRoot, 45, {
      stat: statRecord(45, "second worker", "R", 1, 900),
      status: "Uid:\t1000\t1000\t1000\t1000\nVmRSS:\t100 kB\nVmSize:\t200 kB\n",
      cmdline: "/usr/bin/second-worker\0",
      executable: "/usr/bin/second-worker",
    });
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user" });
    const result = await inspector.listProcesses();

    expect(result.processes.map((process) => process.pid)).toEqual([42, 45]);
  });

  it("keeps partial process results when optional files are unavailable", async () => {
    const procRoot = await createProcFixture();
    await rm(join(procRoot, "42", "status"));
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => null });
    const result = await inspector.listProcesses();

    expect(result.processes).toHaveLength(1);
    expect(result.processes[0]?.memory).toEqual({ rssBytes: null, virtualBytes: null, percentage: null });
    expect(result.errors).toContainEqual(expect.objectContaining({ pid: 42, field: "uid", reason: "unavailable" }));
  });

  it("keeps listing other processes when one process is access denied", async () => {
    const procRoot = await createProcFixture();
    await writeProcess(procRoot, 43, { stat: statRecord(43, "restricted", "S", 1, 600), status: "", cmdline: "", executable: null });
    const fileSystem = createFileSystem({
      readText: async (path) => {
        if (path === join(procRoot, "43", "stat")) throw fileError("EACCES");
        return readFile(path, "utf8");
      },
    });
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user", fileSystem });
    const result = await inspector.listProcesses();

    expect(result.processes.map((process) => process.pid)).toEqual([42]);
    expect(result.errors).toContainEqual(expect.objectContaining({ pid: 43, field: "stat", reason: "access_denied" }));
  });

  it("reports a process disappearing during inspection", async () => {
    const procRoot = await createProcFixture();
    let statReads = 0;
    const fileSystem = createFileSystem({
      readText: async (path) => {
        if (path === join(procRoot, "42", "stat") && ++statReads === 2) throw fileError("ENOENT");
        return readFile(path, "utf8");
      },
    });
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user", fileSystem });
    const result = await inspector.listProcesses();

    expect(result.processes).toEqual([]);
    expect(result.errors).toContainEqual(expect.objectContaining({ pid: 42, field: "stat", reason: "process_disappeared" }));
  });

  it("handles nonexistent, invalid, and inaccessible process IDs distinctly", async () => {
    const procRoot = await createProcFixture();
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100 });
    expect((await inspector.getProcessInfo(-1)).status).toBe("invalid_pid");
    expect((await inspector.getProcessInfo(404)).status).toBe("not_found");
    expect((await inspector.getProcessInfo(43)).status).toBe("not_found");
  });

  it("leaves derived times unavailable when CLK_TCK is not configured", async () => {
    const procRoot = await createProcFixture();
    const inspector = new ProcessInspector({ procRoot, resolveUsername: async () => "fixture-user" });
    const result = await inspector.getProcessInfo(42);

    expect(result.status).toBe("found");
    if (result.status === "found") {
      expect(result.process.startTimeTicks).toBe(500);
      expect(result.process.startTime).toBeNull();
      expect(result.process.elapsedSeconds).toBeNull();
      expect(result.errors).toContainEqual(expect.objectContaining({ field: "clock_tick_rate", reason: "unavailable" }));
    }
  });

  it("returns unavailable memory percentage when total memory is missing or invalid", async () => {
    const procRoot = await createProcFixture();
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user" });

    await writeFile(join(procRoot, "meminfo"), "MemTotal: 0 kB\n");
    const zero = await inspector.getProcessInfo(42);
    expect(zero.status).toBe("found");
    if (zero.status === "found") {
      expect(zero.process.memory.percentage).toBeNull();
      expect(zero.errors).toContainEqual(expect.objectContaining({ field: "meminfo", reason: "malformed" }));
    }

    await writeFile(join(procRoot, "meminfo"), "malformed\n");
    const missing = await inspector.getProcessInfo(42);
    expect(missing.status).toBe("found");
    if (missing.status === "found") {
      expect(missing.process.memory.rssBytes).toBe(2_048_000);
      expect(missing.process.memory.percentage).toBeNull();
      expect(missing.errors).toContainEqual(expect.objectContaining({ field: "meminfo", reason: "malformed" }));
    }
  });

  it("never reads environ", async () => {
    const procRoot = await createProcFixture();
    await writeFile(join(procRoot, "42", "environ"), "SECRET=value\0");
    const readPaths: string[] = [];
    const baseFileSystem = createFileSystem();
    const fileSystem = createFileSystem({
      readText: async (path) => { readPaths.push(path); return baseFileSystem.readText(path); },
      readBuffer: async (path) => { readPaths.push(path); return baseFileSystem.readBuffer(path); },
    });
    const inspector = new ProcessInspector({ procRoot, clockTicksPerSecond: 100, resolveUsername: async () => "fixture-user", fileSystem });
    const result = await inspector.getProcessInfo(42);

    expect(result.status).toBe("found");
    expect(readPaths.some((path) => path.endsWith("/environ"))).toBe(false);
    if (result.status === "found") expect(JSON.stringify(result.process)).not.toContain("SECRET=value");
  });
});

async function createProcFixture(): Promise<string> {
  const procRoot = await mkdtemp(join(tmpdir(), "ganglion-proc-fixture-"));
  temporaryDirectories.push(procRoot);
  await writeFile(join(procRoot, "meminfo"), "MemTotal: 100000 kB\nMemFree: 50000 kB\n");
  await writeFile(join(procRoot, "uptime"), "100.00 50.00\n");
  await writeFile(join(procRoot, "stat"), "cpu 1 2 3 4\nbtime 1700000000\n");
  await writeProcess(procRoot, 42, {
    stat: statRecord(42, "worker (pool) one", "S", 7, 500),
    status: "Name:\tworker\nUid:\t1000\t1000\t1000\t1000\nVmRSS:\t2000 kB\nVmSize:\t8000 kB\n",
    cmdline: "/usr/bin/fixture-worker\0--password=hunter2\0--mode\0safe\0",
    executable: "/usr/bin/fixture-worker",
  });
  return procRoot;
}

async function writeProcess(
  procRoot: string,
  pid: number,
  files: { stat: string; status: string; cmdline: string; executable: string | null },
): Promise<void> {
  const directory = join(procRoot, String(pid));
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "stat"), files.stat);
  await writeFile(join(directory, "status"), files.status);
  await writeFile(join(directory, "cmdline"), files.cmdline);
  if (files.executable !== null) await symlink(files.executable, join(directory, "exe"));
}

function statRecord(
  pid: number,
  name: string,
  state: string,
  ppid: number,
  startTimeTicks: number,
  userCpuTicks = 14,
  systemCpuTicks = 15,
): string {
  const fields = Array.from({ length: 21 }, () => "0");
  fields[0] = state;
  fields[1] = String(ppid);
  fields[11] = String(userCpuTicks);
  fields[12] = String(systemCpuTicks);
  fields[13] = "100000";
  fields[14] = "200000";
  fields[19] = String(startTimeTicks);
  fields[20] = "8192000";
  return `${pid} (${name}) ${fields.join(" ")}\n`;
}

function createFileSystem(overrides: Partial<ProcessInspectorFileSystem> = {}): ProcessInspectorFileSystem {
  return {
    readText: (path) => readFile(path, "utf8"),
    readBuffer: (path) => readFile(path),
    readLink: (path) => readlink(path),
    readDirectory: (path) => readdir(path, { withFileTypes: true, encoding: "utf8" }),
    ...overrides,
  };
}

function fileError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}