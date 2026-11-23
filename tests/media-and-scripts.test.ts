import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MediaControlAdapter } from "../src/mcp/adapters/media-control.ts";
import { parseScripts, ScriptRunnerAdapter } from "../src/mcp/adapters/script-runner.ts";

describe("media_control (G1.4)", () => {
  function fakeDbus(players: Record<string, string>) {
    const calls: string[][] = [];
    const run = async (file: string, args: string[]) => {
      calls.push([file, ...args]);
      if (args.includes("org.freedesktop.DBus.ListNames")) return `(['org.freedesktop.DBus', ${Object.keys(players).map((p) => `'${p}'`).join(", ")}],)`;
      if (args.includes("PlaybackStatus")) return `(<'${players[args[args.indexOf("--dest") + 1]!]}'>,)`;
      if (file === "wpctl" && args[0] === "get-volume") return "Volume: 0.30\n";
      return "()";
    };
    return { calls, adapter: new MediaControlAdapter(run, "linux") };
  }

  it("is a read tool that takes only a command from a fixed list", () => {
    const tool = new MediaControlAdapter(async () => "", "linux").tools()[0]!;
    expect(tool.permission).toBe("read");
    expect(tool.inputSchema).toMatchObject({ additionalProperties: false, properties: { command: { enum: expect.arrayContaining(["pause", "next", "volume_up"]) } } });
  });

  it("pauses the player that is actually playing", async () => {
    const { calls, adapter } = fakeDbus({ "org.mpris.MediaPlayer2.vlc": "Paused", "org.mpris.MediaPlayer2.spotify": "Playing" });
    expect(await adapter.control("pause")).toEqual({ status: "done", command: "pause", player: "spotify" });
    expect(calls.at(-1)).toContain("org.mpris.MediaPlayer2.Player.Pause");
    expect(calls.at(-1)).toContain("org.mpris.MediaPlayer2.spotify");
  });

  it("says so when nothing is playing, and changes volume through wpctl", async () => {
    const { adapter, calls } = fakeDbus({});
    await expect(adapter.control("next")).rejects.toThrow("Nothing is playing");
    expect(await adapter.control("volume_up")).toEqual({ status: "done", command: "volume_up", volume: "Volume: 0.30" });
    expect(calls.find((c) => c[1] === "set-volume")).toEqual(["wpctl", "set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", "5%+"]);
  });

  it("refuses a command outside the list", async () => {
    const tool = new MediaControlAdapter(async () => "", "linux").tools()[0]!;
    await expect(tool.handler({ command: "rm -rf ~" }, {})).rejects.toThrow("command must be one of");
  });
});

describe("run_script — trigger, never compose (G2.2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ganglion-scripts-"));
  const path = join(dir, "hello.sh");
  writeFileSync(path, "#!/bin/sh\necho \"hello $1\"\necho oops >&2\nexit 3\n");
  chmodSync(path, 0o755);
  const scripts = parseScripts(JSON.stringify([{ id: "hello", path, args: ["mio"], description: "says hello" }]))!;

  it("is an Action tool whose only argument is a registered id", () => {
    const tool = new ScriptRunnerAdapter(scripts).tools()[0]!;
    expect(tool.permission).toBe("action");
    expect(tool.inputSchema).toEqual({ type: "object", properties: { id: { type: "string", enum: ["hello"], description: "The id of a registered script." } }, required: ["id"], additionalProperties: false });
    expect(tool.description).toContain("hello (says hello)");
  });

  it("runs the registered program with the registered arguments, without a shell", async () => {
    const result = await new ScriptRunnerAdapter(scripts).tools()[0]!.handler({ id: "hello" }, {});
    expect(result).toMatchObject({ status: "failed", id: "hello", exit_code: 3, timed_out: false });
    // stdout and stderr are two pipes, so their lines can arrive in either order.
    expect(String((result as { output: string }).output).split("\n").sort()).toEqual(["hello mio", "oops"]);
  });

  it("throws on a command string, or on extra arguments, and never runs anything", async () => {
    let ran = false;
    const tool = new ScriptRunnerAdapter(scripts, async () => { ran = true; return { exit_code: 0, output: "", timed_out: false }; }).tools()[0]!;
    await expect(tool.handler({ id: "rm -rf ~" }, {})).rejects.toThrow("No registered script");
    await expect(tool.handler({ id: `${path}; id` }, {})).rejects.toThrow("No registered script");
    await expect(tool.handler({ command: "hello" }, {})).rejects.toThrow("No registered script");
    expect(ran).toBe(false);
  });

  it("refuses a bad registration", () => {
    expect(() => parseScripts(JSON.stringify([{ id: "Has Space", path }]))).toThrow("Invalid script id");
    expect(() => parseScripts(JSON.stringify([{ id: "rel", path: "backup.sh" }]))).toThrow("path must be absolute");
    expect(() => parseScripts(JSON.stringify([{ id: "a", path }, { id: "a", path }]))).toThrow("duplicate id");
    expect(() => parseScripts(JSON.stringify([{ id: "a", path, args: "--all" }]))).toThrow("args must be strings");
  });
});
