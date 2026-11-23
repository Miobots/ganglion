# miobots-ganglion

See `CLAUDE.md` for the rules that apply here.

```bash
bun install
bun run pair --folder ~/Documents/Mio   # once: shows a six-digit code to type into the app
bun run settings                        # optional: tool levels, folders, approvals on this laptop
bun run start:confined                  # the daemon in its jail (Linux); `bun start` runs it unconfined
```

## Running confined (Linux)

`bun run start:confined` needs `bwrap` (bubblewrap), `xdg-dbus-proxy` and a C compiler; on Ubuntu,
`sudo apt install bubblewrap xdg-dbus-proxy build-essential`. It compiles `sandbox/ganglion-sandbox.c`
on first run. Inside, the daemon sees only system files, this code, its config, the approved folders,
registered scripts and the screenshots folder; D-Bus reaches only the screenshot portal,
notifications and media players; TCP reaches only the Brain's port and nothing may listen; 41
dangerous system calls are refused. Apps and volume changes go through a broker outside, by name
only. `bun test tests/confinement.test.ts` runs a hostile program in the same jail and checks each
attempt to escape is refused (GANGLION_DECISIONS 36).

## Settings, tiers, connectors, desktop approvals

`bun run settings` opens GNOME dialogs to change one tool's level at a time ("ask on the phone" or
"run without asking"), the approved folders, and whether approvals also appear on this laptop. It
writes `config.json` only; restart the daemon to apply. The same keys can be written by hand:

```json
{
  "tiers": { "media_control": "action" },
  "desktopApprovals": true,
  "connectors": [{ "name": "notes", "command": "/usr/local/bin/notes-mcp", "args": ["--read-only"] }]
}
```

`tiers` keys must name one tool each; there is no blanket key. A connector is an MCP server over
stdio; its tools appear as `notes.<tool>` and start at the Action tier until you lower one
(GANGLION_DECISIONS 34, 35).

## Platforms

Built and tested on Linux (GNOME, Wayland). On macOS and Windows only system status, opening apps
and URLs, scripts (unconfined) and the platform-independent tools have code, and none of it has been
run there; media, screen capture and confinement are not built (GANGLION_DECISIONS 37).

`bun run pair` connects to Brain (`--brain`, default `ws://127.0.0.1:8080/ws`), shows a code, and
waits up to five minutes for someone to type it into the app (Devices → Pair a laptop). It then
saves this laptop's own token to `~/.config/miobots-ganglion/credentials.json` (mode 0600) and the
approved folders, read-only, to `config.json` beside it. Repeat `--folder` for more folders; run it
again to re-pair. For development, `BRAIN_WS_URL`, `GANGLION_DEVICE_ID`, `GANGLION_TOKEN` and
`GANGLION_FILESYSTEM_POLICY` override the saved files.

Bun, one lockfile, one pinned TypeScript — the same toolchain as `miobots-brain` and
`miobots-protocol` (BRAIN_DECISIONS 21).

Design documentation is in the Obsidian vault two levels up.

**Status: MCP server and Brain WebSocket transport are implemented.**

The server core is independently testable through an injected transport. Only explicitly registered tools are
advertised. Filesystem tools operate inside human-approved directories, use read/action permissions,
refuse overwrites unless explicitly requested, and require approval for actions and deletion.
Every call is recorded in Brain's hash-chained audit log before it runs (BRAIN_DECISIONS 29). Filesystem tools are disabled unless an allowed-directory
policy is supplied.

Set `GANGLION_FILESYSTEM_POLICY` to a JSON policy to enable them:

```bash
export GANGLION_FILESYSTEM_POLICY='{"approvedDirectories":[{"path":"/home/user/Documents","allowWrite":true}]}'
```

Each directory path must be absolute. Set `allowWrite` to `false` for read-only access. Optional
positive-integer limits can be provided in a `limits` object, including `maxReadBytes`,
`maxWriteBytes`, `maxSearchBytes`, `maxSearchResults`, `maxSearchDepth`, `maxDirectoryEntries`, and
`maxSearchEntries`. With one approved directory, `filesystem.list`, `filesystem.search`, and
`filesystem.get_info` use that directory when `path` is omitted or empty. Relative file and folder
paths such as `notes.txt` or `reports/notes.txt` are resolved inside the sole approved directory;
file operations still require a filename, and move/copy require both source and destination.

Filesystem reads remain available with this policy alone. To enable filesystem write, move, copy,
directory creation, and deletion in the local MCP DEV flow, set
`MCP_DEV_ALLOW_FILESYSTEM_ACTIONS=true` in both the Brain and Ganglion environments and restart
both processes with `NODE_ENV=development`. It is disabled by default and rejected outside development.
Deletion additionally requires `confirmed: true`; recursive
deletion requires both `recursive: true` and `confirmed: true`.

## Process Management

Linux process management is disabled unless `GANGLION_PROCESS_MANAGEMENT` is explicitly configured.
It is not registered on other platforms. For example:

```bash
export GANGLION_PROCESS_MANAGEMENT='{"enabled":true,"clockTicksPerSecond":100,"sampleIntervalMs":1000,"protectedPids":[]}'
```

For isolated local end-to-end testing only, Ganglion separately supports
`GANGLION_DEV_AUTO_APPROVE_PROCESS_ACTIONS=true`. It is accepted only with
`NODE_ENV=development`; other environments fail startup rather than enabling the bypass. The flag
approves only `process.terminate` and does not change filesystem or unrelated
action permissions. Process tools still require `GANGLION_PROCESS_MANAGEMENT` to be enabled, and
ProcessManager continues to enforce protected PIDs, PID/start-time identity checks, OS permissions,
and explicit signal selection. This is not a trusted approval UI and must not be used in production.
`clockTicksPerSecond` is optional, but Ganglion does not infer or assume its value. When omitted,
process inspection remains available and CPU usage is reported as unavailable. Set it to the value
verified for the host (for example, `getconf CLK_TCK` reports `100` on some Ubuntu systems; Ganglion
does not execute `getconf`). `sampleIntervalMs` defaults to 1000 ms. CPU percentages are per-core:
100% represents one logical CPU fully utilized and values can exceed 100% on multicore workloads.
The first sample establishes a baseline, so CPU remains unavailable until a subsequent sample.

The adapter exposes four tools: `process.list` lists visible processes, `process.get_info` retrieves
one process, `process.find` filters the list, and `process.terminate` signals one specifically
selected process. Name matching in `process.find` is
case-insensitive and partial; executable and username filters are exact. Filters combine with AND,
and the tool returns all matches rather than selecting one.

For termination, the expected agent workflow is discovery, presentation, user selection, then
termination: call `process.find`, show all matches to the user, and pass the selected result's `pid`
and `startTimeTicks` to `process.terminate`. PID alone is not accepted. The start-time identity lets
Ganglion reject a stale selection if the PID now belongs to a different process. It does not
eliminate the small race between the final `/proc` check and signaling; native pidfd support is not
implemented.

Process reads use the existing `read` permission. Termination uses the existing `action`
permission and trusted, non-voice approval flow. Enabling this feature does not approve actions.
Ganglion does not expose arbitrary process launch; scripts must be registered by ID in a future tool.

Termination is limited by the OS permissions of the user running Ganglion. PID 1, Ganglion itself,
Ganglion's ancestors, and configured `protectedPids` are protected. `SIGTERM` is the default;
`SIGKILL` is forceful and must be explicitly requested. Ganglion never escalates automatically.
Memory values use bytes: RSS is resident physical memory, virtual memory is address-space size, and
the percentage is RSS divided by total physical memory. Process inspection does not read process
environment variables.

## App and URL Launcher

The `open_app_or_url` tool exposes registered application and website launching. It is disabled
unless a human writes a target list: an `appLauncher` entry in `~/.config/miobots-ganglion/config.json`
(`{"appLauncher":{"allowedTargets":[...]}}`, beside the folders pairing saved), or
`GANGLION_APP_ALLOWLIST`, which overrides it:

```bash
export GANGLION_APP_ALLOWLIST='[{"name":"docs","type":"url","target":"https://docs.miobots.org"},{"name":"calc","type":"app","target":"/usr/bin/gnome-calculator"}]'
```

In accordance with the **trigger, never compose** rule (`GANGLION_DECISIONS` 21-22), the agent can
only trigger pre-registered target identifiers. Arbitrary command compose or unlisted URLs are
strictly rejected. Applications are spawned without shell interpolation (`shell: false`). The tool
is Action-tier gated: it runs only when Brain's call carries an **approval ticket** from a tap on the
phone, matching this tool and these exact arguments, unexpired and unused (BRAIN_DECISIONS 27).

## Registered scripts (`run_script`)

`run_script` triggers a script a human registered, by id. It never builds or accepts a command: its
only argument is an id from the list, and the program and its arguments come from the registration.
Write the list into `config.json` (re-pairing keeps it), or set `GANGLION_SCRIPTS` to override it:

```json
{ "scripts": [{ "id": "backup-photos", "path": "/home/me/bin/backup-photos.sh", "args": ["--quiet"], "description": "copies Photos to the NAS" }] }
```

Ids are lowercase letters, digits, `-` and `_`; paths must be absolute. Scripts run without a shell,
for at most 60 s, and the last 4 KB of output comes back. Action tier: each run needs a tap on the
phone (`GANGLION_DECISIONS` 32).

## Media control (`media_control`)

Play, pause, next, previous, volume up/down by 5% and mute, on Linux, with nothing to install:
players are driven over MPRIS with `gdbus`, volume through PipeWire with `wpctl`. It acts on the
player that is playing. Read tier, so no tap is needed.

## Connection Resilience & Reconnection

The daemon outbound transport (`BrainWebSocketTransport`) maintains connection liveness via periodic
`sys.heartbeat` exchanges with Brain. When a connection drops or Brain restarts, Ganglion automatically
reconnects using jittered exponential backoff (1s to 10s with randomized jitter factor) in accordance
with `ProtocolDefaults`. The backoff counter resets upon successful `sys.welcome` authentication.

## Security & Path Traversal Testing

Path resolution in `SecureFilesystem` resolves canonical paths via `realpath()` *before* enforcing
approved directory containment. Automated tests in `tests/security.test.ts` verify refusal of:
1. Relative path traversal climbing (`../../`).
2. Plain absolute path escapes outside configured roots (`/etc/passwd`).
3. Symlinks created inside the approved directory that point out-of-bounds.

