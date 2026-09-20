# Ganglion — the desktop tool daemon

**The one component the entire system is designed to work completely without.** If it is absent,
Brain reports that one step failed and continues. It never blocks anything else and never appears
in a failure path for another feature.

**Formerly called "Cowork"** — renamed because *Claude Cowork* is a shipping product in the same
problem space. A ganglion processes signals outside the central nervous system, which is exactly
what a daemon on a separate machine does.

---

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

**Resolve symlinks first, then check the path is inside an approved folder.** Checking before
resolution is the classic escape and a one-line mistake. This is the one place in this repo where a
bug is a real vulnerability rather than an inconvenience.

**Arbitrary shell execution is not in scope and is not planned.**

---

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

**Scaffold only, and this repo is deliberately last.** Building it before the four hero features
are stable is the most likely way this project runs out of time — the internal proposal's own risk
register names exactly that.

One exception: the permission round-trip pairs with the app's approval surface, and those two
unblock each other.

## Platform reality

Linux is built properly, with kernel-level confinement — Landlock for filesystem scoping, seccomp
for syscall filtering, a separate low-privilege user, and no network by default. macOS and Windows
get the separate-user baseline until there is time.

**Six operations touch the OS** and sit behind a platform adapter: capture screen, open app or URL,
media control, system status, launch a confined process, autostart. Everything else is
platform-independent — which is what makes the other two platforms "implement two files" rather
than a redesign.

**Screen capture on Wayland goes through `xdg-desktop-portal` and the compositor shows its own
consent prompt.** Whether a persistent token survives across sessions is unverified and decides
whether this tool is usable as designed. Check that before building around it.

## Where the design lives

- `../../03 Engineering/Components/Ganglion/GANGLION_SPEC.md` — what and why, including how this
  compares to OpenWork and OpenWorker
- `../../03 Engineering/Components/Ganglion/GANGLION_DECISIONS.md` — **wins on conflict**
- `../../03 Engineering/Components/Ganglion/GANGLION_TASKS.md`
