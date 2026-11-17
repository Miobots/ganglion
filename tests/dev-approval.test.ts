import { describe, expect, it } from "bun:test";
import { createGanglionDevApprovalProvider, parseGanglionDevAutoApproveProcessActions } from "../src/mcp/dev-approval.ts";
import { DefaultPermissionManager } from "../src/mcp/permissions.ts";
import { DefaultToolRegistry } from "../src/mcp/registry.ts";
import { ProcessManager } from "../src/mcp/process/process-manager.ts";
import type { ProcessInfo, ProcessInspectionResult } from "../src/mcp/process/types.ts";
import type { RegisteredTool } from "../src/mcp/types.ts";

describe("Ganglion development process-action approval", () => {
  it("keeps the flag false by default and rejects enabling it outside development", () => {
    expect(parseGanglionDevAutoApproveProcessActions(undefined, "development")).toBe(false);
    expect(parseGanglionDevAutoApproveProcessActions("false", "development")).toBe(false);
    expect(parseGanglionDevAutoApproveProcessActions("true", "development")).toBe(true);
    expect(() => parseGanglionDevAutoApproveProcessActions("true", "production")).toThrow(/NODE_ENV=development/);
    expect(() => parseGanglionDevAutoApproveProcessActions("true", undefined)).toThrow(/NODE_ENV=development/);
    expect(() => parseGanglionDevAutoApproveProcessActions("yes", "development")).toThrow(/'true' or 'false'/);
  });

  it("approves only process.terminate when opted in", async () => {
    const off = createGanglionDevApprovalProvider({ allowFilesystemActions: false, allowProcessActions: false });
    const on = createGanglionDevApprovalProvider({ allowFilesystemActions: false, allowProcessActions: true }, "development");
    const processStart = approvalRequest("process.start");
    const processTerminate = approvalRequest("process.terminate");
    const filesystemAction = approvalRequest("filesystem.write_file");
    const unrelatedAction = approvalRequest("system.shutdown");

    expect(await off.requestApproval(processStart)).toBe(false);
    expect(await off.requestApproval(processTerminate)).toBe(false);
    expect(await on.requestApproval(processStart)).toBe(false);
    expect(await on.requestApproval(processTerminate)).toBe(true);
    expect(await on.requestApproval(filesystemAction)).toBe(false);
    expect(await on.requestApproval(unrelatedAction)).toBe(false);
  });

  it("preserves existing filesystem behavior without widening other actions", async () => {
    const off = createGanglionDevApprovalProvider({ allowFilesystemActions: false, allowProcessActions: false });
    const fsEnabled = createGanglionDevApprovalProvider({ allowFilesystemActions: true, allowProcessActions: false }, "development");
    const processEnabled = createGanglionDevApprovalProvider({ allowFilesystemActions: false, allowProcessActions: true }, "development");

    expect(await off.requestApproval(approvalRequest("filesystem.write_file"))).toBe(false);
    expect(await fsEnabled.requestApproval(approvalRequest("filesystem.write_file"))).toBe(true);
    expect(await fsEnabled.requestApproval(approvalRequest("process.start"))).toBe(false);
    expect(await processEnabled.requestApproval(approvalRequest("filesystem.write_file"))).toBe(false);
  });

  it("does not bypass ProcessManager protected-PID or identity checks", async () => {
    const approval = createGanglionDevApprovalProvider({ allowFilesystemActions: false, allowProcessActions: true }, "development");
    const protectedManager = createManager(1, 10);
    const protectedTool = managerTerminationTool(protectedManager);
    const protectedRegistry = new DefaultToolRegistry(new DefaultPermissionManager(approval));
    protectedRegistry.register(protectedTool);
    await expect(protectedRegistry.execute("process.terminate", { identity: { pid: 1, startTimeTicks: 10 } })).resolves.toMatchObject({
      status: "protected_process",
      signalSent: false,
    });

    const staleManager = createManager(42, 999);
    const staleTool = managerTerminationTool(staleManager);
    const staleRegistry = new DefaultToolRegistry(new DefaultPermissionManager(approval));
    staleRegistry.register(staleTool);
    await expect(staleRegistry.execute("process.terminate", { identity: { pid: 42, startTimeTicks: 420 } })).resolves.toMatchObject({
      status: "identity_mismatch",
      signalSent: false,
    });
  });

  it("refuses filesystem action auto-approval outside development", () => {
    expect(() => createGanglionDevApprovalProvider({ allowFilesystemActions: true, allowProcessActions: false }, "production"))
      .toThrow(/NODE_ENV=development/);
  });
});

function approvalRequest(toolName: string) {
  return { toolName, tier: "action" as const, target: "test-target", reason: "isolated local test" };
}

function managerTerminationTool(manager: ProcessManager): RegisteredTool {
  return {
    name: "process.terminate",
    description: "Test process termination action",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    permission: "action",
    family: "confined_process",
    enabled: true,
    handler: async (input) => manager.terminateProcess(input as never),
  };
}

function createManager(targetPid: number, actualStartTimeTicks: number): ProcessManager {
  const inspectionRecords = new Map<number, { ppid: number; startTimeTicks: number }>([
    [100, { ppid: 90, startTimeTicks: 1000 }],
    [90, { ppid: 1, startTimeTicks: 900 }],
    [targetPid, { ppid: 1, startTimeTicks: actualStartTimeTicks }],
  ]);
  const inspector = {
    getProcessInfo: async (pid: number): Promise<ProcessInspectionResult> => {
      const process = inspectionRecords.get(pid);
      if (!process) return { status: "not_found", pid, errors: [] };
      return { status: "found", process: processInfo(pid, process.ppid, process.startTimeTicks), errors: [] };
    },
  };
  return new ProcessManager({
    policy: { enabled: true, ganglionPid: 100 },
    inspector,
    signalProcess: () => { throw new Error("signal must not be sent in this test"); },
  });
}

function processInfo(pid: number, ppid: number, startTimeTicks: number): ProcessInfo {
  return {
    pid,
    ppid,
    name: "fixture-process",
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
