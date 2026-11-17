import { describe, expect, it } from "bun:test";
import { ProcessManager, type ProcessManagerOptions } from "../src/mcp/process/process-manager.ts";
import type { ProcessInfo, ProcessInspectionResult, SupportedTerminationSignal } from "../src/mcp/process/types.ts";

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

function createHarness(overrides: Partial<ProcessManagerOptions> = {}) {
  const signalCalls: Array<{ pid: number; signal: SupportedTerminationSignal }> = [];
  const signalProcess = (pid: number, signal: SupportedTerminationSignal): boolean => {
    signalCalls.push({ pid, signal });
    return true;
  };
  const inspector = createInspector();
  const manager = new ProcessManager({
    policy: { enabled: true, ganglionPid: 100 },
    inspector,
    signalProcess,
    ...overrides,
  });
  return { manager, signal: { calls: signalCalls }, inspector: inspector as ReturnType<typeof createInspector> };
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