export * from "./mcp/types.ts";
export * from "./mcp/permissions.ts";
export * from "./mcp/registry.ts";
export * from "./mcp/filesystem/secure-filesystem.ts";
export * from "./mcp/filesystem/policy.ts";
export * from "./mcp/tools/filesystem.ts";
export * from "./mcp/adapters/filesystem.ts";
export * from "./mcp/sdk-transport.ts";
export * from "./mcp/server.ts";
export * from "./mcp/adapters/system-status.ts";
export * from "./mcp/bootstrap.ts";
export * from "./mcp/portal.ts";
export * from "./mcp/adapters/screen-capture.ts";
export * from "./mcp/process/types.ts";
export * from "./mcp/process/policy.ts";
export * from "./mcp/process/process-inspector.ts";
export * from "./mcp/process/process-cpu-sampler.ts";
export * from "./mcp/process/process-manager.ts";
export * from "./mcp/adapters/process.ts";

/** Phase 2 transport integration supplies the injected transport at runtime. */
export function assertTransportConfigured(transport: unknown): asserts transport {
	if (!transport || typeof transport !== "object") {
		throw new Error("Ganglion transport is not configured; inject the Brain WebSocket adapter");
	}
}
