# Ganglion — the desktop tool daemon

**The one component the entire system is designed to work completely without.** If it is absent,
Brain reports that one step failed and continues. It never blocks anything else and never appears
in a failure path for another feature.

**Formerly called "Cowork"** — renamed because *Claude Cowork* is a shipping product in the same
problem space. A ganglion processes signals outside the central nervous system, which is exactly
what a daemon on a separate machine does.


## Non-negotiable rules

**Ganglion never talks to Heart or Synapse directly. Ever.** All traffic is Brain-mediated. That is
what produces one authentication model and one audit log instead of three.

**The daemon dials out.** No inbound port, no firewall exception.

**Trigger, never compose.** `run_script` may trigger a pre-registered script. It may **never**
build a command string. A registered script can be read and approved before it ever runs; a
composed command cannot be, and "validate this command is safe" is precisely the step that fails.

**The agent may never add, install or enable a tool or connector. Only the human can.** Without
this the allow-list is self-extending and *"a tool that is not registered does not exist"* stops
being true — and that sentence is the load-bearing claim of the whole security story.

**Tools from a newly added connector default to the most restrictive tier.** An unknown tool is not
a safe tool.

**Voice may announce and prompt, but voice may never approve an Action-tier call.** The approval
lands on a token-holding surface. If anyone in the room can say "haan" and authorize a desktop
action, recognition has become authorization.

**Auto mode is scoped per-tool or per-directory, never global.** A blanket approve-everything
toggle reduces the rest of the permission model to decoration.

The temporary `GANGLION_DEV_AUTO_APPROVE_PROCESS_ACTIONS=true` exception is isolated local testing
only, requires `NODE_ENV=development`, and authorizes only the two process action names. It does not
remove ProcessManager policy, protected PID, or identity checks and must never be enabled in
production.
**Resolve symlinks first, then check the path is inside an approved folder.** Checking before
resolution is the classic escape and a one-line mistake. This is the one place in this repo where a
bug is a real vulnerability rather than an inconvenience.

**Arbitrary shell execution is not in scope and is not planned.** Process launching is a separate,
explicitly enabled Linux capability: it accepts an executable and argument array with `shell: false`,
but it is arbitrary execution and is not an OS sandbox. It always requires the existing trusted,
non-voice action approval; development auto-approval must remain scoped to its existing tools.


## Run

```bash
bun install
bun start        # Bun runs TypeScript directly — no build step
bun test
bun run typecheck
```

**Bun, one lockfile, one pinned TypeScript** — BRAIN_DECISIONS 21, which covers this repo too.
The vault `CLAUDE.md` toolchain rule names `miobots-ganglion` explicitly; this file said `npm`
until now, which is the drift `DECISIONS_PENDING.md` predicted when decision 21 landed.

## Current state

The daemon dials out to Brain over `BrainWebSocketTransport` and serves MCP over it. The official
MCP SDK owns the MCP lifecycle; Ganglion owns registration, local permissions, and the adapters:
system status (battery, CPU load, memory, disk), approved-directory filesystem, app launcher,
media control (MPRIS and PipeWire, Read tier), registered scripts (`run_script`, Action tier),
opt-in process management, and screen capture. Ganglion still does not open a listener or communicate
directly with Heart or Synapse.

Brain's main agent reaches this daemon only through `ask_laptop` (BRAIN_DECISIONS 26). Read-tier
tools run directly; Action-tier tools wait for a tap on the phone (BRAIN_DECISIONS 27).

**A daemon connects only with its own paired token** (GANGLION_DECISIONS 29). `bun run pair
--folder <dir>` shows a six-digit code, a human types it into the app, and the token lands in
`~/.config/miobots-ganglion/credentials.json` (mode 0600) beside `config.json`, which holds the
approved folders. **No tool may ever write either file**; that is what keeps the folder list out
of the agent's reach.

**An Action-tier tool runs only against Brain's approval ticket** (GANGLION_DECISIONS 30): the
tool, a SHA-256 of the exact arguments as received, unexpired, and used once. An invalid ticket is
refused, never passed on to another approver.

**Only a close that won't be retried ends the MCP session** (GANGLION_DECISIONS 31). The SDK
detaches its server on `onclose` for good, so a reconnecting drop must not report it. The daemon
keeps no audit chain and does nothing for the kill switch: Brain records the rows and refuses the
connection.

**`run_script` takes an id and nothing else** (GANGLION_DECISIONS 32). Its schema is an enum of
registered ids; the program and arguments come from the human's `config.json`. Never add a field
that carries a command, a path or extra arguments. `media_control` is Read tier, from a fixed list.

**Not built yet:** the kernel confinement below (`G5.1`–`G5.3`; the daemon runs as the logged-in
user) and a desktop approval surface (`G6.1`).

## Platform reality

Linux is built properly, with kernel-level confinement — Landlock for filesystem scoping, seccomp
for syscall filtering, a separate low-privilege user, and no network by default. macOS and Windows
get the separate-user baseline until there is time.

OS operations sit behind platform adapters. Process management is currently Linux-only and explicitly
opt-in. Its five tools list, inspect, find, start, and terminate processes. Discovery returns all
matches; the agent must present them and obtain a specific user selection before terminating with
both PID and `startTimeTicks`. PID 1, Ganglion, its ancestors, and configured protected PIDs cannot
be terminated. The final `/proc` identity check still has a small race before signaling; pidfd support
is not implemented. Process actions remain subject to the Ganglion OS user's permissions.

CPU sampling uses configured `clockTicksPerSecond` and a background interval; no universal tick rate
is assumed. CPU percentage is per-core and may exceed 100%. Memory is reported in bytes, with RSS
separate from virtual memory. The `confined_process` capability name does not provide kernel or OS
confinement.

**Screen capture on Wayland goes through `xdg-desktop-portal`, and GNOME asks once and remembers**
(GANGLION_DECISIONS 33, verified within a session; a post-reboot check is owed). The capture is
shrunk to a JPEG of at most 44 KB so it fits one protocol message, and GNOME's saved copy in
`~/Pictures` is deleted at once. Never offer the agent the interactive picker.

## Where the design lives

  compares to OpenWork and OpenWorker
