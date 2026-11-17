import { describe, expect, it } from "bun:test";
import { DefaultPermissionManager } from "../src/mcp/permissions.ts";
import { DefaultToolRegistry } from "../src/mcp/registry.ts";
import { ProcessAdapter } from "../src/mcp/adapters/process.ts";
import { parseProcessManagementConfiguration } from "../src/mcp/process/policy.ts";
import type { ProcessCpuSampler } from "../src/mcp/process/process-cpu-sampler.ts";
import type { ProcessInspector } from "../src/mcp/process/process-inspector.ts";
import type { ProcessManager } from "../src/mcp/process/process-manager.ts";
import type { ProcessInfo, ProcessInspectionResult, ProcessTerminationResult } from "../src/mcp/process/types.ts";
import type { RegisteredTool } from "../src/mcp/types.ts";

describe("ProcessAdapter", () => {
  it("keeps process configuration opt-in and validates supplied tick rates", () => {
    expect(parseProcessManagementConfiguration()).toBeUndefined();
    expect(parseProcessManagementConfiguration(JSON.stringify({ enabled: true, protectedPids: [123], clockTicksPerSecond: 100 })))
      .toEqual({ enabled: true, protectedPids: [123], clockTicksPerSecond: 100 });
    expect(() => parseProcessManagementConfiguration(JSON.stringify({ enabled: true, clockTicksPerSecond: 0 })))
      .toThrow(/clockTicksPerSecond/);
    expect(() => parseProcessManagementConfiguration(JSON.stringify({ enabled: true, unexpected: true })))
      .toThrow(/supported settings/);
  });

  it("registers exactly four tools with read/action permissions and is Linux-only", () => {
    const adapter = createAdapter({ platform: "linux" });
    expect(adapter.isAvailable()).toBe(true);
    expect(adapter.tools().map(({ name, permission }) => [name, permission])).toEqual([
      ["process.list", "read"],
      ["process.get_info", "read"],
      ["process.find", "read"],
      ["process.terminate", "action"],
    ]);
    expect(createAdapter({ platform: "win32" }).isAvailable()).toBe(false);
  });

  it("returns normalized process records and partial inspection errors from process.list", async () => {
    const adapter = createAdapter();
    const result = await tool(adapter, "process.list").handler({}, {});

    expect(result).toEqual({ processes: [processRecord(41, "Chrome Renderer", 4100)], errors: [] });
    expect(JSON.stringify(result)).not.toContain("environ");
  });

  it("validates process.get_info PID strictly and returns clear inspector results", async () => {
    const adapter = createAdapter();
    const getInfo = tool(adapter, "process.get_info");
    await expect(getInfo.handler({ pid: 0 }, {})).rejects.toThrow(/PID/);
    await expect(getInfo.handler({ pid: 1.5 }, {})).rejects.toThrow(/PID/);
    await expect(getInfo.handler({ pid: "41" }, {})).rejects.toThrow(/PID/);
    await expect(getInfo.handler({ pid: 999 }, {})).resolves.toMatchObject({ status: "not_found", pid: 999 });
    expect((await getInfo.handler({ pid: 41 }, {}))).toMatchObject({ status: "found", process: { pid: 41, startTimeTicks: 4100 } });
  });

  it("finds all partial case-insensitive name matches and preserves identity", async () => {
    const adapter = createAdapter({ processes: [
      processRecord(41, "Chrome Renderer", 4100),
      processRecord(42, "chrome", 4200),
      processRecord(43, "Firefox", 4300),
    ] });
    const result = await tool(adapter, "process.find").handler({ name: "CHRO" }, {});

    expect(result).toMatchObject({ count: 2, processes: [
      { pid: 41, startTimeTicks: 4100 },
      { pid: 42, startTimeTicks: 4200 },
    ] });
  });

  it("matches executable, username, and PID filters exactly and combines filters with AND", async () => {
    const adapter = createAdapter({ processes: [
      processRecord(41, "Chrome", 4100, { executable: "/usr/bin/chrome", username: "alice" }),
      processRecord(42, "Chrome Helper", 4200, { executable: "/usr/bin/chrome-helper", username: "bob" }),
    ] });
    const find = tool(adapter, "process.find");

    expect(await find.handler({ executable: "/usr/bin/chrome", username: "alice" }, {})).toMatchObject({ count: 1, processes: [{ pid: 41 }] });
    expect(await find.handler({ username: "bob" }, {})).toMatchObject({ count: 1, processes: [{ pid: 42 }] });
    expect(await find.handler({ pid: 42 }, {})).toMatchObject({ count: 1, processes: [{ pid: 42 }] });
    expect(await find.handler({ executable: "/usr/bin/chrome", pid: 42 }, {})).toMatchObject({ count: 0, processes: [] });
  });

  it("rejects empty or malformed filters and gives an explicit no-match result", async () => {
    const find = tool(createAdapter(), "process.find");
    await expect(find.handler({}, {})).rejects.toThrow(/At least one/);
    await expect(find.handler({ name: "  " }, {})).rejects.toThrow(/non-empty/);
    await expect(find.handler({ pid: 2.2 }, {})).rejects.toThrow(/PID/);
    await expect(find.handler({ unknown: "x" }, {})).rejects.toThrow(/Unsupported/);
    await expect(find.handler({ name: "not-present" }, {})).resolves.toMatchObject({ count: 0, processes: [] });
  });

  it("requests specific termination approval and forwards only selected PID identity", async () => {
    const harness = createAdapterHarness();
    const terminationTool = tool(harness.adapter, "process.terminate");
    const approval = await terminationTool.approvalRequest?.({ pid: 41, startTimeTicks: 4100, signal: "SIGKILL" });
    expect(approval?.target).toContain('"pid":41');
    expect(approval?.target).toContain('"name":"Chrome Renderer"');
    expect(approval?.target).toContain('"startTimeTicks":4100');
    expect(approval?.target).toContain('"signal":"SIGKILL"');
    expect(approval?.reason).toMatch(/Forcefully/);

    const registry = new DefaultToolRegistry(new DefaultPermissionManager({
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async () => true,
    }));
    registerAll(registry, harness.adapter);
    await expect(registry.execute("process.terminate", { pid: 41, startTimeTicks: 4100 })).resolves.toEqual(terminationResult);
    expect(harness.manager.terminateCalls).toEqual([{ identity: { pid: 41, startTimeTicks: 4100 } }]);
  });

  it("does not call ProcessManager when termination approval is denied or identity is missing", async () => {
    const harness = createAdapterHarness();
    const registry = new DefaultToolRegistry(new DefaultPermissionManager({
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async () => false,
    }));
    registerAll(registry, harness.adapter);

    await expect(registry.execute("process.terminate", { pid: 41 })).rejects.toThrow(/startTimeTicks/);
    await expect(registry.execute("process.terminate", { pid: 41, startTimeTicks: 4100 })).rejects.toThrow(/not approved/);
    expect(harness.manager.terminateCalls).toHaveLength(0);
  });

  it("delegates sampler lifecycle without starting duplicate loops itself", async () => {
    const harness = createAdapterHarness();
    await harness.adapter.start?.();
    await harness.adapter.stop?.();
    expect(harness.sampler.startCalls).toBe(1);
    expect(harness.sampler.stopCalls).toBe(1);
  });
});

const terminationResult: ProcessTerminationResult = {
  status: "signalled", pid: 41, signal: "SIGTERM", signalSent: true, error: null,
};

function createAdapterHarness(overrides: { processes?: ProcessInfo[]; platform?: NodeJS.Platform } = {}) {
  const processes = overrides.processes ?? [processRecord(41, "Chrome Renderer", 4100)];
  const inspector = {
    listProcesses: async () => ({ processes, errors: [] }),
    getProcessInfo: async (pid: number): Promise<ProcessInspectionResult> => {
      const process = processes.find((item) => item.pid === pid);
      return process
        ? { status: "found", process, errors: [] }
        : { status: "not_found", pid, errors: [] };
    },
  };
  const sampler = { startCalls: 0, stopCalls: 0, start: async () => { sampler.startCalls++; }, stop: async () => { sampler.stopCalls++; } };
  const manager = {
    terminateCalls: [] as unknown[],
    terminateProcess: async (options: unknown) => { manager.terminateCalls.push(options); return terminationResult; },
  };
  const approvals: Array<{ toolName: string; tier: "action"; target?: string; reason: string }> = [];
  const adapter = new ProcessAdapter({
    inspector: inspector as unknown as ProcessAdapterOptionsLike["inspector"],
    sampler: sampler as unknown as ProcessAdapterOptionsLike["sampler"],
    manager: manager as unknown as ProcessAdapterOptionsLike["manager"],
    ...(overrides.platform ? { platform: overrides.platform } : {}),
  });
  return { adapter, manager, sampler, approvals };
}

function createAdapter(options: { platform?: NodeJS.Platform; processes?: ProcessInfo[] } = {}): ProcessAdapter {
  return createAdapterHarness(options).adapter;
}

type ProcessAdapterOptionsLike = ConstructorParameters<typeof ProcessAdapter>[0];

function registerAll(registry: DefaultToolRegistry, adapter: ProcessAdapter): void {
  for (const processTool of adapter.tools()) registry.register(processTool);
}

function tool(adapter: ProcessAdapter, name: string): RegisteredTool<any> {
  const found = adapter.tools().find((item) => item.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

function processRecord(
  pid: number,
  name: string,
  startTimeTicks: number,
  overrides: Partial<ProcessInfo> = {},
): ProcessInfo {
  return {
    pid,
    ppid: 1,
    name,
    executable: "/usr/bin/chrome",
    commandLine: ["chrome"],
    state: "sleeping",
    uid: 1000,
    username: "alice",
    memory: { rssBytes: 2_000, virtualBytes: 8_000, percentage: 0.1 },
    cpu: { available: true, percentage: 50 },
    startTimeTicks,
    startTime: 1_700_000_000_000,
    elapsedSeconds: 30,
    ...overrides,
  };
}