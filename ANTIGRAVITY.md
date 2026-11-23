# Ganglion (`miobots-ganglion`) — Antigravity Rules

**Removable desktop worker daemon.** Node/TS/Bun daemon executing local tools dispatched by Brain.

---

## Non-Negotiable Invariants

1. **Deliberately Removable (Offline class: DIES):** The system must work 100% without Ganglion. If Ganglion drops offline, Brain logs the failure for that specific step and proceeds.
2. **Mediated Access Exclusively Through Brain:** Ganglion never communicates directly with Heart or Synapse.
3. **Trigger-Never-Compose:** Exposes `run_script(id)` by pre-registered ID. The agent can **never** pass raw shell strings.
4. **Canonical Symlink Resolution:** `file_read(path)` uses `fs.realpathSync()` *before* checking path boundaries against approved folder roots.
5. **Voice-Never-Approves:** Action-tier desktop tools require manual confirmation via phone/desktop prompt; spoken replies cannot authorize actions.
6. **Linux Kernel Confinement:** Dedicated low-privilege user (`_mio_ganglion`) scoped with Landlock LSM and seccomp syscall filters (blocking outbound internet sockets).
7. **Own Token, Folders Fixed at Pairing:** `bun run pair --folder <dir>` shows a six-digit code typed into the app; the daemon then holds its own token (`credentials.json`, mode 0600) and its approved folders (`config.json`). No tool may write either file, so the agent can never widen the folder list (GANGLION_DECISIONS 29).
8. **Actions Need a Ticket:** An Action-tier tool runs only when the MCP call's `_meta` carries Brain's approval ticket matching this tool and the exact arguments, unexpired and unused; an invalid ticket is refused outright (GANGLION_DECISIONS 30).
9. **Reconnects Keep the Session:** only a close that will not be retried may call `onclose`, because the MCP SDK detaches for good on it. No local audit chain and no kill switch logic here: Brain does both (GANGLION_DECISIONS 31).
10. **Scripts by Id Only:** `run_script`'s only argument is an id from the registered enum; program and arguments come from the human's `config.json`. Never add a field carrying a command, path or argument. `media_control` is Read tier from a fixed list (GANGLION_DECISIONS 32).
11. **Screenshots Leave Nothing Behind:** capture through the Screenshot portal non-interactively, delete GNOME's saved copy at once, and shrink to a JPEG of at most 44 KB so it fits one message (GANGLION_DECISIONS 33).
12. **Run Confined:** `bun run start:confined` jails the daemon (bubblewrap, filtered D-Bus, Landlock, seccomp). Never mount the real session bus, the PipeWire socket or the home directory into it; the broker outside accepts only a registered app name or a fixed volume command (GANGLION_DECISIONS 36).
13. **One Tool at a Time:** tiers change per tool in `bun run settings`, never with a blanket key; connector tools start at Action. A desktop approval surface is opt-in and shows the exact arguments (GANGLION_DECISIONS 34, 35).

---

## Toolchain & Commands (Bun)

```bash
bun install        # Install dependencies
bun test           # Run security & unit tests
bun run src/index.ts # Start Ganglion daemon
```
