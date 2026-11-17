import type { ApprovalProvider } from "./types.ts";

const PROCESS_ACTIONS = new Set(["process.start", "process.terminate"]);

export function parseGanglionDevAutoApproveProcessActions(
  value = process.env.GANGLION_DEV_AUTO_APPROVE_PROCESS_ACTIONS,
  nodeEnv = process.env.NODE_ENV,
): boolean {
  if (value === undefined || value === "false") return false;
  if (value !== "true") throw new Error("GANGLION_DEV_AUTO_APPROVE_PROCESS_ACTIONS must be 'true' or 'false'");
  if (nodeEnv !== "development") {
    throw new Error("GANGLION_DEV_AUTO_APPROVE_PROCESS_ACTIONS=true is allowed only when NODE_ENV=development");
  }
  return true;
}

export function createGanglionDevApprovalProvider(options: {
  allowFilesystemActions: boolean;
  allowProcessActions: boolean;
}): ApprovalProvider {
  return {
    isTrusted: () => true,
    isVoiceApproval: () => false,
    requestApproval: async (request) => {
      if (request.toolName.startsWith("filesystem.")) {
        if (options.allowFilesystemActions) {
          console.info(`[Ganglion] MCP DEV filesystem action enabled tool=${request.toolName} target=${request.target ?? "unknown"}`);
          return true;
        }
        return false;
      }

      if (PROCESS_ACTIONS.has(request.toolName) && options.allowProcessActions) {
        console.warn(`[Ganglion] DEVELOPMENT ONLY process action auto-approved tool=${request.toolName} target=${request.target ?? "unknown"}`);
        return true;
      }

      return false;
    },
  };
}