import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";
import { McpToolError } from "../types.ts";

/**
 * `run_script` (G2.2) — trigger, never compose (GANGLION_DECISIONS 21–22).
 *
 * The agent names a script a human registered in `config.json`, by id, and nothing else: the
 * schema has one field, it must match a registered id exactly, and the program and its arguments
 * come from the registration. There is no code path that accepts a command string, so passing one
 * is just an unknown id. Action tier: it runs only against Brain's approval ticket.
 */

export interface RegisteredScript {
  /** What the agent and the approval card see, e.g. "backup-photos". */
  id: string;
  /** Absolute path to the program, run without a shell. */
  path: string;
  /** Fixed arguments, written by the human. */
  args?: string[];
  /** One line for the agent: what it does. */
  description?: string;
}

const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const OUTPUT_LIMIT = 4_000;
const TIMEOUT_MS = 60_000;

export function parseScripts(raw?: string): RegisteredScript[] | undefined {
  if (!raw || !raw.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Invalid scripts: must be a list");
  const scripts = parsed.map((item: Record<string, unknown>) => {
    if (typeof item?.id !== "string" || !ID.test(item.id)) throw new Error(`Invalid script id ${JSON.stringify(item?.id)}: lowercase letters, digits, - and _`);
    if (typeof item.path !== "string" || !isAbsolute(item.path)) throw new Error(`Script ${item.id}: path must be absolute`);
    if (item.args !== undefined && !(Array.isArray(item.args) && item.args.every((arg) => typeof arg === "string"))) throw new Error(`Script ${item.id}: args must be strings`);
    return {
      id: item.id,
      path: item.path,
      ...(item.args ? { args: item.args as string[] } : {}),
      ...(typeof item.description === "string" ? { description: item.description } : {}),
    };
  });
  if (new Set(scripts.map((s) => s.id)).size !== scripts.length) throw new Error("Invalid scripts: duplicate id");
  return scripts;
}

export type ScriptResult = { exit_code: number | null; output: string; timed_out: boolean };

function runFile(script: RegisteredScript): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(script.path, script.args ?? [], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const keep = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-OUTPUT_LIMIT); };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, TIMEOUT_MS);
    child.on("error", (error) => { clearTimeout(timer); reject(new McpToolError("script_failed", `Could not start ${script.id}: ${error.message}`)); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exit_code: code, output: output.trim(), timed_out: timedOut }); });
  });
}

const INPUT_SCHEMA = (ids: string[]): ToolSchema => ({
  type: "object",
  properties: { id: { type: "string", enum: ids, description: "The id of a registered script." } },
  required: ["id"],
  additionalProperties: false,
});

export class ScriptRunnerAdapter implements CapabilityAdapter {
  readonly family = "confined_process" as const;

  private readonly scripts: RegisteredScript[];
  private readonly run: (script: RegisteredScript) => Promise<ScriptResult>;

  constructor(scripts: RegisteredScript[], run: (script: RegisteredScript) => Promise<ScriptResult> = runFile) {
    this.scripts = scripts;
    this.run = run;
  }

  isAvailable(): boolean {
    return this.scripts.length > 0;
  }

  private find(input: unknown): RegisteredScript {
    const id = (input as { id?: unknown })?.id;
    const script = typeof id === "string" ? this.scripts.find((s) => s.id === id) : undefined;
    if (!script) throw new McpToolError("unregistered_script", `No registered script has the id ${JSON.stringify(id)}. Scripts are registered by a human; a command cannot be run.`);
    return script;
  }

  tools(): RegisteredTool[] {
    return [{
      name: "run_script",
      description: "Run one script a human registered on the laptop, by its id. It cannot run any other command. Needs approval on the phone. " +
        `Registered: ${this.scripts.map((s) => (s.description ? `${s.id} (${s.description})` : s.id)).join("; ")}.`,
      inputSchema: INPUT_SCHEMA(this.scripts.map((s) => s.id)),
      permission: "action",
      family: this.family,
      enabled: true,
      approvalRequest: async (input: unknown) => {
        const script = this.find(input);
        return { target: script.path, reason: `Run registered script '${script.id}' (${[script.path, ...(script.args ?? [])].join(" ")})` };
      },
      handler: async (input: unknown) => {
        const script = this.find(input);
        const result = await this.run(script);
        return { status: result.timed_out ? "timed_out" : result.exit_code === 0 ? "done" : "failed", id: script.id, ...result };
      },
    }];
  }
}
