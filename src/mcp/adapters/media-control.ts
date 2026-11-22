import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CapabilityAdapter, RegisteredTool, ToolSchema } from "../types.ts";
import { McpToolError } from "../types.ts";

/**
 * `media_control` (G1.4) — "Mio, pause the music". Read tier (GANGLION_DECISIONS 21): it changes
 * nothing that can't be changed straight back, so it needs no tap.
 *
 * Linux only, and nothing to install: players are driven through MPRIS on the session D-Bus with
 * `gdbus`, and volume through PipeWire with `wpctl`. Both run without a shell, from a fixed command
 * list; the agent only picks one of the names below.
 */

export const MEDIA_COMMANDS = ["play_pause", "play", "pause", "next", "previous", "volume_up", "volume_down", "mute_toggle"] as const;
export type MediaCommand = (typeof MEDIA_COMMANDS)[number];

const PLAYER_METHOD: Partial<Record<MediaCommand, string>> = {
  play_pause: "PlayPause",
  play: "Play",
  pause: "Pause",
  next: "Next",
  previous: "Previous",
};

/** Runs one program with fixed arguments and returns its stdout. Injected in tests. */
export type Run = (file: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);
const defaultRun: Run = async (file, args) => (await execFileAsync(file, args, { timeout: 5_000 })).stdout;

const INPUT_SCHEMA: ToolSchema = {
  type: "object",
  properties: {
    command: { type: "string", enum: [...MEDIA_COMMANDS], description: "What to do to whatever is playing." },
  },
  required: ["command"],
  additionalProperties: false,
};

const SINK = "@DEFAULT_AUDIO_SINK@";

export class MediaControlAdapter implements CapabilityAdapter {
  readonly family = "media_control" as const;

  private readonly run: Run;
  private readonly platform: NodeJS.Platform;

  constructor(run: Run = defaultRun, platform: NodeJS.Platform = process.platform) {
    this.run = run;
    this.platform = platform;
  }

  isAvailable(): boolean {
    return this.platform === "linux";
  }

  /** MPRIS players on the session bus, a playing one first. */
  async players(): Promise<string[]> {
    const names = (await this.run("gdbus", ["call", "--session", "--dest", "org.freedesktop.DBus", "--object-path", "/org/freedesktop/DBus", "--method", "org.freedesktop.DBus.ListNames"]))
      .match(/org\.mpris\.MediaPlayer2\.[\w.-]+/g) ?? [];
    const playing: string[] = [];
    for (const name of names) {
      const status = await this.run("gdbus", ["call", "--session", "--dest", name, "--object-path", "/org/mpris/MediaPlayer2", "--method", "org.freedesktop.DBus.Properties.Get", "org.mpris.MediaPlayer2.Player", "PlaybackStatus"]).catch(() => "");
      if (status.includes("Playing")) playing.push(name);
    }
    return [...playing, ...names.filter((name) => !playing.includes(name))];
  }

  async control(command: MediaCommand): Promise<Record<string, unknown>> {
    const method = PLAYER_METHOD[command];
    if (method) {
      const player = (await this.players())[0];
      if (!player) throw new McpToolError("no_player", "Nothing is playing media on the laptop.");
      await this.run("gdbus", ["call", "--session", "--dest", player, "--object-path", "/org/mpris/MediaPlayer2", "--method", `org.mpris.MediaPlayer2.Player.${method}`]);
      return { status: "done", command, player: player.replace("org.mpris.MediaPlayer2.", "") };
    }
    const volumeArgs = command === "volume_up" ? ["set-volume", "-l", "1.0", SINK, "5%+"]
      : command === "volume_down" ? ["set-volume", SINK, "5%-"]
      : ["set-mute", SINK, "toggle"];
    await this.run("wpctl", volumeArgs);
    const volume = (await this.run("wpctl", ["get-volume", SINK])).trim(); // "Volume: 0.30 [MUTED]"
    return { status: "done", command, volume };
  }

  tools(): RegisteredTool[] {
    return [{
      name: "media_control",
      description: "Control media on the laptop: play, pause, next or previous track, volume up or down by 5%, or mute. Acts on whatever is playing.",
      inputSchema: INPUT_SCHEMA,
      permission: "read",
      family: this.family,
      enabled: true,
      handler: async (input: unknown) => {
        const command = (input as { command?: unknown })?.command;
        if (typeof command !== "string" || !(MEDIA_COMMANDS as readonly string[]).includes(command)) {
          throw new McpToolError("invalid_arguments", `command must be one of: ${MEDIA_COMMANDS.join(", ")}`);
        }
        return this.control(command as MediaCommand);
      },
    }];
  }
}
