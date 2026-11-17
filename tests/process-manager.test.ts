import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions, spawn as nodeSpawn } from "node:child_process";
import { ProcessManager, type ProcessManagerOptions } from "../src/mcp/process/process-manager.ts";
import type { ProcessInfo, ProcessInspectionResult, SupportedTerminationSignal } from "../src/mcp/process/types.ts";

describe("ProcessManager starting processes", () => {
  it("passes executable, individual args, and cwd directly to spawn without a shell or output capture", async () => {
    const harness = createHarness();
    const result = await harness.manager.startProcess({
      executable: "/opt/tools/worker",
      args: ["two words", "$(touch /tmp/should-not-run)", "; sudo whoami"],
      cwd: "/work",
    });

    expect(result).toEqual({
      status: "started",
      pid: 4321,
      executable: "/opt/tools/worker",
      workingDirectory: "/work",
      error: null,
    });
    expect(harness.spawn.calls).toHaveLength(1);
    expect(harness.spawn.calls[0]).toMatchObject({
      executable: "/opt/tools/worker",
      args: ["two words", "$(touch /tmp/should-not-run)", "; sudo whoami"],
      options: { shell: false, detached: false, stdio: "ignore", cwd: "/work" },
    });
    expect(Object.keys(harness.spawn.calls[0]!.options.env ?? {})).toEqual(["PATH"]);
  });

  it("defaults args to an empty array and reports the actual inherited working directory", async () => {
    const harness = createHarness({ getWorkingDirectory: () => "/ganglion" });
    const result = await harness.manager.startProcess({ executable: "worker" });

    expect(result).toMatchObject({ status: "started", executable: "worker", workingDirectory: "/ganglion" });
    expect(harness.spawn.calls[0]?.args).toEqual([]);
    expect(harness.spawn.calls[0]?.options).not.toHaveProperty("cwd");
  });

  it("rejects invalid executable values without invoking spawn", async () => {
    const harness = createHarness();
    const inputs = [
      { executable: "" },
      { executable: "   " },
      { executable: "/bin/tool\0bad" },
      { executable: null },
    ];

    for (const input of inputs) {
      const result = await harness.manager.startProcess(input as never);
      expect(result.status).toBe("failed");
    }
    expect(harness.spawn.calls).toHaveLength(0);
  });

  it("rejects invalid argument types and null bytes", async () => {
    const harness = createHarness();
    for (const args of [null, "one string", ["ok", 4], ["bad\0arg"], new Array(1)]) {
      const result = await harness.manager.startProcess({ executable: "worker", args } as never);
      expect(result.error?.code).toBe("invalid_arguments");
    }
    expect(harness.spawn.calls).toHaveLength(0);
  });

  it("rejects invalid, nonexistent, and non-directory working directories", async () => {
    const harness = createHarness({
      fileSystem: { stat: async (path) => ({ isDirectory: () => path === "/work" }) },
    });
    for (const cwd of ["", "  ", "/work\0bad", 3, null]) {
      const result = await harness.manager.startProcess({ executable: "worker", cwd } as never);
      expect(result.error?.code).toBe("invalid_cwd");
    }
    expect((await harness.manager.startProcess({ executable: "worker", cwd: "/missing" })).error?.code).toBe("invalid_cwd");
    expect(harness.spawn.calls).toHaveLength(0);
  });

  it("returns an executable-not-found result for an asynchronous ENOENT", async () => {
    const harness = createHarness({ spawnProcess: fakeSpawner({ event: "error", error: codedError("ENOENT") }).spawnProcess });
    const result = await harness.manager.startProcess({ executable: "missing-command", args: ["secret", "value"] });

    expect(result).toMatchObject({ status: "failed", pid: null, error: { code: "executable_not_found" } });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("handles asynchronous spawn errors and never returns before spawn is accepted", async () => {
    const harness = createHarness({ spawnProcess: fakeSpawner({ event: "error", error: codedError("EACCES") }).spawnProcess });
    const result = await harness.manager.startProcess({ executable: "/restricted/tool" });
    expect(result).toMatchObject({ status: "failed", error: { code: "permission_denied" } });
  });

  it("does not start processes when process management is disabled", async () => {
    const harness = createHarness({ policy: { enabled: false, ganglionPid: 100 } });
    const result = await harness.manager.startProcess({ executable: "worker" });

    expect(result.status).toBe("disabled");
    expect(harness.spawn.calls).toHaveLength(0);
  });
});

describe("ProcessManager terminating processes", () => {
  it("uses SIGTERM by default and revalidates identity immediately before signalling", async () => {
    const harness = createHarness();
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result).toMatchObject({ status: "signalled", pid: 42, signal: "SIGTERM", signalSent: true, error: null });
    expect(harness.inspector.calls.slice(-3)).toEqual([100, 90, 42]);
    expect(harness.signal.calls).toEqual([{ pid: 42, signal: "SIGTERM" }]);
  });

  it("uses SIGKILL only when explicitly requested", async () => {
    const harness = createHarness();
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 }, signal: "SIGKILL" });

    expect(result).toMatchObject({ status: "signalled", signal: "SIGKILL", signalSent: true });
    expect(harness.signal.calls).toEqual([{ pid: 42, signal: "SIGKILL" }]);
  });

  it("does not escalate after a SIGTERM permission failure", async () => {
    let attempts = 0;
    const harness = createHarness({ signalProcess: () => { attempts++; throw codedError("EPERM"); } });
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result).toMatchObject({ status: "permission_denied", signal: "SIGTERM", signalSent: false });
    expect(attempts).toBe(1);
  });

  it("handles invalid PID, invalid identity, invalid signal, and missing processes", async () => {
    const harness = createHarness();
    expect((await harness.manager.terminateProcess({ identity: { pid: 0, startTimeTicks: 420 } })).status).toBe("invalid_pid");
    expect((await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: -1 } })).status).toBe("invalid_identity");
    expect((await harness.manager.terminateProcess({ identity: { pid: 42 } } as never)).status).toBe("invalid_identity");
    expect((await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 }, signal: "SIGUSR1" } as never)).status).toBe("invalid_signal");
    expect((await harness.manager.terminateProcess({ identity: { pid: 404, startTimeTicks: 404 } })).status).toBe("not_found");
    expect(harness.signal.calls).toHaveLength(0);
  });

  it("rejects PID/start-time mismatches without signalling", async () => {
    const harness = createHarness();
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 999 } });

    expect(result).toMatchObject({ status: "identity_mismatch", signalSent: false, error: { code: "identity_mismatch" } });
    expect(harness.signal.calls).toHaveLength(0);
  });

  it("reports a process that disappears before signalling as not found", async () => {
    const inspector = createInspector(undefined, new Map([[42, { status: "not_found", pid: 42, errors: [] }]]));
    const harness = createHarness({ inspector });
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result.status).toBe("not_found");
    expect(harness.signal.calls).toHaveLength(0);
  });

  it("maps ESRCH from the OS signal operation to not found", async () => {
    const harness = createHarness({ signalProcess: () => { throw codedError("ESRCH"); } });
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result).toMatchObject({ status: "not_found", error: { code: "process_not_found" } });
  });

  it("maps EPERM from the OS signal operation to permission denied", async () => {
    const harness = createHarness({ signalProcess: () => { throw codedError("EPERM"); } });
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result).toMatchObject({ status: "permission_denied", error: { code: "permission_denied" } });
  });

  it("protects PID 1, Ganglion itself, ancestors, and configured protected PIDs", async () => {
    const harness = createHarness({ policy: { enabled: true, ganglionPid: 100, protectedPids: [77] } });
    const targets = [1, 100, 90, 77];

    for (const pid of targets) {
      const result = await harness.manager.terminateProcess({ identity: { pid, startTimeTicks: pid * 10 } });
      expect(result.status).toBe("protected_process");
    }
    expect(harness.signal.calls).toHaveLength(0);
  });

  it("fails closed when the Ganglion ancestor chain cannot be verified", async () => {
    const inspector = createInspector(new Map(), new Map([[100, { status: "access_denied", pid: 100, errors: [] }]]));
    const harness = createHarness({ inspector });
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result).toMatchObject({ status: "protection_check_failed", signalSent: false });
    expect(harness.signal.calls).toHaveLength(0);
  });

  it("does not allow operation arguments to override protected PIDs or expected identity", async () => {
    const harness = createHarness();
    const protectedResult = await harness.manager.terminateProcess({
      identity: { pid: 100, startTimeTicks: 1000 },
      protectedPids: [],
    } as never);
    const identityResult = await harness.manager.terminateProcess({
      identity: { pid: 42, startTimeTicks: 999 },
      expectedIdentity: { pid: 42, startTimeTicks: 420 },
    } as never);

    expect(protectedResult.status).toBe("protected_process");
    expect(identityResult.status).toBe("identity_mismatch");
    expect(harness.signal.calls).toHaveLength(0);
  });

  it("does not signal when process management is disabled", async () => {
    const harness = createHarness({ policy: { enabled: false, ganglionPid: 100 } });
    const result = await harness.manager.terminateProcess({ identity: { pid: 42, startTimeTicks: 420 } });

    expect(result.status).toBe("disabled");
    expect(harness.signal.calls).toHaveLength(0);
  });
});

interface SpawnCall {
  executable: string;
  args: string[];
  options: SpawnOptions;
}

function createHarness(overrides: Partial<ProcessManagerOptions> = {}) {
  const spawn = fakeSpawner();
  const signalCalls: Array<{ pid: number; signal: SupportedTerminationSignal }> = [];
  const signalProcess = (pid: number, signal: SupportedTerminationSignal): boolean => {
    signalCalls.push({ pid, signal });
    return true;
  };
  const inspector = createInspector();
  const manager = new ProcessManager({
    policy: { enabled: true, ganglionPid: 100 },
    inspector,
    spawnProcess: spawn.spawnProcess,
    signalProcess,
    fileSystem: { stat: async () => ({ isDirectory: () => true }) },
    getWorkingDirectory: () => "/service",
    ...overrides,
  });
  return { manager, spawn, signal: { calls: signalCalls }, inspector: inspector as ReturnType<typeof createInspector> };
}

function fakeSpawner(options: { event?: "spawn" | "error"; error?: Error; pid?: number } = {}) {
  const calls: SpawnCall[] = [];
  const spawnProcess = ((executable: string, args: string[], spawnOptions: SpawnOptions) => {
    calls.push({ executable, args, options: spawnOptions });
    const child = Object.assign(new EventEmitter(), { pid: options.pid ?? 4321 }) as ChildProcess;
    queueMicrotask(() => {
      if (options.event === "error") child.emit("error", options.error ?? new Error("spawn failed"));
      else child.emit("spawn");
    });
    return child;
  }) as typeof nodeSpawn;
  return { spawnProcess, calls };
}

function createInspector(
  records: Map<number, { ppid: number; startTimeTicks: number }> = new Map([
    [100, { ppid: 90, startTimeTicks: 1000 }],
    [90, { ppid: 1, startTimeTicks: 900 }],
    [42, { ppid: 1, startTimeTicks: 420 }],
  ]),
  overrides = new Map<number, ProcessInspectionResult>(),
) {
  const calls: number[] = [];
  return {
    calls,
    getProcessInfo: async (pid: number): Promise<ProcessInspectionResult> => {
      calls.push(pid);
      const override = overrides.get(pid);
      if (override) return override;
      const record = records.get(pid);
      return record
        ? { status: "found", process: processInfo(pid, record.ppid, record.startTimeTicks), errors: [] }
        : { status: "not_found", pid, errors: [] };
    },
  };
}

function processInfo(pid: number, ppid: number, startTimeTicks: number): ProcessInfo {
  return {
    pid,
    ppid,
    name: "test-process",
    executable: null,
    commandLine: null,
    state: "sleeping",
    uid: null,
    username: null,
    memory: { rssBytes: null, virtualBytes: null, percentage: null },
    cpu: { available: false, reason: "sampling_not_started" },
    startTimeTicks,
    startTime: null,
    elapsedSeconds: null,
  };
}

function codedError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}