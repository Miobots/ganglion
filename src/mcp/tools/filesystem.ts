import type { RegisteredTool, ToolSchema } from "../types.ts";
import { SecureFilesystem } from "../filesystem/secure-filesystem.ts";

export function filesystemTools(filesystem: SecureFilesystem): RegisteredTool[] {
  return [
    tool("filesystem.list", "List an approved directory. If one approved directory is configured, omitting path or using an empty path lists that directory. Relative paths start at the approved directory.", { path: { type: "string", maxLength: 4_096 } }, [], "read", async (input) => filesystem.list(input.path)),
    tool("filesystem.search", "Search approved file and directory names, and optionally file contents. Omit path to search the sole approved directory; relative paths start there.", {
      path: { type: "string", maxLength: 4_096 },
      query: stringSchema(),
      includeContent: { type: "boolean", description: "Search text file contents as well as names; defaults to true." },
      maxResults: { type: "number", minimum: 1, maximum: 100 },
    }, ["query"], "read", async (input) => filesystem.search(input.path, input.query, input.includeContent !== false, input.maxResults)),
    tool("filesystem.get_info", "Get metadata for an approved file or directory. Omit path to inspect the sole approved directory; relative paths start there.", { path: { type: "string", maxLength: 4_096 } }, [], "read", async (input) => filesystem.getInfo(input.path)),
    tool("filesystem.read_file", "Read an approved UTF-8 text file within the configured size limit. Relative file paths start at the approved directory.", { path: stringSchema() }, ["path"], "read", async (input) => filesystem.readFile(input.path)),
    tool("filesystem.create_directory", "Create a directory inside the approved directory. Relative paths start there; provide the new directory name.", { path: stringSchema() }, ["path"], "action", async (input) => filesystem.createDirectory(input.path), async (input) => ({
      target: await filesystem.approvalTarget([input.path]), reason: "Create directory",
    })),
    tool("filesystem.write_file", "Write a UTF-8 text file without overwriting unless overwrite is explicitly enabled. Relative file paths start at the approved directory; provide a filename.", {
      path: stringSchema(), content: { type: "string", maxLength: 1_048_576 }, overwrite: { type: "boolean" },
    }, ["path", "content"], "action", async (input) => filesystem.writeFile(input.path, input.content, input.overwrite === true), async (input) => ({
      target: await filesystem.approvalTarget([input.path]), reason: input.overwrite ? "Overwrite file" : "Create file",
    })),
    tool("filesystem.move", "Move an approved file or directory without overwriting. Relative source and destination paths start at the approved directory.", {
      source: stringSchema(), destination: stringSchema(),
    }, ["source", "destination"], "action", async (input) => filesystem.move(input.source, input.destination), async (input) => ({
        target: await filesystem.approvalTarget([input.source, input.destination], [true, true], [false, true]), reason: "Move filesystem path",
    })),
    tool("filesystem.copy", "Copy an approved file or directory without overwriting. Relative source and destination paths start at the approved directory.", {
      source: stringSchema(), destination: stringSchema(),
    }, ["source", "destination"], "action", async (input) => filesystem.copy(input.source, input.destination), async (input) => ({
        target: await filesystem.approvalTarget([input.source, input.destination], [false, true], [false, true]), reason: "Copy filesystem path",
    })),
    tool("filesystem.delete", "Delete an approved file or directory after explicit trusted confirmation. Relative paths start at the approved directory.", {
      path: stringSchema(), recursive: { type: "boolean" }, confirmed: { type: "boolean" },
    }, ["path", "confirmed"], "action", async (input) => filesystem.delete(input.path, input.recursive === true, input.confirmed), async (input) => {
      if (!input.confirmed) throw new Error("Deletion requires explicit approval");
      return {
        target: await filesystem.approvalTarget([input.path], true, false),
        reason: input.recursive ? "Recursively delete path" : "Delete path",
      };
    }),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, ToolSchema>,
  required: string[],
  permission: "read" | "action",
  handler: (input: Record<string, any>) => Promise<unknown>,
  approvalRequest?: (input: Record<string, any>) => Promise<{ target?: string; reason?: string }>,
): RegisteredTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    permission,
    family: "filesystem",
    enabled: true,
    handler: async (input) => handler(input as Record<string, any>),
    ...(approvalRequest ? { approvalRequest: async (input) => approvalRequest(input as Record<string, any>) } : {}),
  };
}

function stringSchema(): ToolSchema {
  return { type: "string", minLength: 1 };
}