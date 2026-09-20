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

---

## Toolchain & Commands (Bun)

```bash
bun install        # Install dependencies
bun test           # Run security & unit tests
bun run src/index.ts # Start Ganglion daemon
```
