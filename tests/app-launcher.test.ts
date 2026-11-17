import { describe, expect, it } from "bun:test";
import { AppLauncherAdapter, parseAppLauncherPolicy, type RegisteredAppOrUrl } from "../src/mcp/adapters/app-launcher.ts";
import { DefaultToolRegistry } from "../src/mcp/registry.ts";
import { DefaultPermissionManager } from "../src/mcp/permissions.ts";
import type { ApprovalProvider } from "../src/mcp/types.ts";

describe("AppLauncherAdapter (Task G2.1)", () => {
  it("parses valid policy and rejects malformed or unapproved targets", () => {
    const policy = parseAppLauncherPolicy(JSON.stringify([
      { name: "browser", type: "url", target: "https://miobots.org" },
      { name: "calculator", type: "app", target: "/usr/bin/calc", args: ["--simple"] },
    ]));
    expect(policy).toBeDefined();
    expect(policy!.allowedTargets).toHaveLength(2);
    expect(policy!.allowedTargets[0]!.name).toBe("browser");
    expect(policy!.allowedTargets[1]!.args).toEqual(["--simple"]);

    // Missing http/https on url
    expect(() => parseAppLauncherPolicy(JSON.stringify([
      { name: "bad", type: "url", target: "javascript:alert(1)" },
    ]))).toThrow(/http:\/\/ or https:\/\//);

    // Empty string or missing policy returns undefined
    expect(parseAppLauncherPolicy(undefined)).toBeUndefined();
    expect(parseAppLauncherPolicy("")).toBeUndefined();
  });

  it("registers open_app_or_url as an Action-tier tool and requires approval", async () => {
    let launched: RegisteredAppOrUrl | undefined;
    const adapter = new AppLauncherAdapter({
      policy: {
        allowedTargets: [
          { name: "docs", type: "url", target: "https://docs.miobots.org" },
          { name: "terminal", type: "app", target: "/usr/bin/xterm" },
        ],
      },
      launcher: async (entry) => { launched = entry; },
    });

    expect(adapter.isAvailable()).toBe(true);
    const tools = adapter.tools();
    expect(tools).toHaveLength(1);
    const openTool = tools[0]!;
    expect(openTool.name).toBe("open_app_or_url");
    expect(openTool.permission).toBe("action");
    expect(openTool.family).toBe("open_application_or_url");

    // Approval request generates exact target and reason
    const approval = await openTool.approvalRequest?.({ name: "docs" });
    expect(approval).toEqual({
      target: "https://docs.miobots.org",
      reason: "Open registered url 'docs' (https://docs.miobots.org)",
    });

    // Unregistered target is rejected before launch
    await expect(openTool.approvalRequest?.({ name: "unknown" })).rejects.toThrow(/not in the registered allow-list/);

    // Gating with PermissionManager: denied without approval
    const denyingApprovalProvider: ApprovalProvider = {
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async () => false,
    };
    const registry = new DefaultToolRegistry(new DefaultPermissionManager(denyingApprovalProvider));
    registry.register(openTool);

    await expect(registry.execute("open_app_or_url", { name: "docs" })).rejects.toThrow(/Action was not approved/);
    expect(launched).toBeUndefined();

    // Voice recognition CANNOT approve (voice may announce, never approve)
    const voiceApprovalProvider: ApprovalProvider = {
      isTrusted: () => true,
      isVoiceApproval: () => true,
      requestApproval: async () => true,
    };
    const voiceRegistry = new DefaultToolRegistry(new DefaultPermissionManager(voiceApprovalProvider));
    voiceRegistry.register(openTool);
    await expect(voiceRegistry.execute("open_app_or_url", { name: "docs" })).rejects.toThrow(/Trusted approval is required/);
    expect(launched).toBeUndefined();

    // Approved by trusted non-voice surface: launches target
    const approvingProvider: ApprovalProvider = {
      isTrusted: () => true,
      isVoiceApproval: () => false,
      requestApproval: async () => true,
    };
    const activeRegistry = new DefaultToolRegistry(new DefaultPermissionManager(approvingProvider));
    activeRegistry.register(openTool);

    const result = await activeRegistry.execute("open_app_or_url", { name: "docs" });
    expect(result).toEqual({
      status: "opened",
      name: "docs",
      type: "url",
      target: "https://docs.miobots.org",
    });
    expect(launched).toEqual({
      name: "docs",
      type: "url",
      target: "https://docs.miobots.org",
    });
  });
});
