export * from "./mcp/types.ts";
export * from "./mcp/permissions.ts";
export * from "./mcp/registry.ts";
export * from "./mcp/filesystem.ts";
export * from "./mcp/sdk-transport.ts";
export * from "./mcp/server.ts";
export * from "./mcp/system-status.ts";
export * from "./mcp/bootstrap.ts";
export * from "./mcp/portal.ts";
export * from "./mcp/screen-capture.ts";

/** Phase 2 transport integration supplies the injected transport at runtime. */
export function assertTransportConfigured(transport: unknown): asserts transport {
	if (!transport || typeof transport !== "object") {
		throw new Error("Ganglion transport is not configured; inject the Brain WebSocket adapter");
	}
}
