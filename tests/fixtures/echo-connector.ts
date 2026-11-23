// A tiny MCP server over stdio, standing in for a connector a human added.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1" });
server.registerTool("Echo Text", { description: "Repeats text", inputSchema: { text: z.string(), times: z.number().int() } },
  async ({ text, times }) => ({ content: [{ type: "text", text: String(text).repeat(times) }] }));
await server.connect(new StdioServerTransport());
