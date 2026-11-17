# miobots-ganglion

See `CLAUDE.md` for the rules that apply here.

```bash
bun install
bun start
```

Bun, one lockfile, one pinned TypeScript — the same toolchain as `miobots-brain` and
`miobots-protocol` (BRAIN_DECISIONS 21).

Design documentation is in the Obsidian vault two levels up.

**Status: Phase 3 MCP server core.** The MCP server is functional and independently testable, but
the Phase 2 Brain WebSocket transport adapter remains a separate integration dependency.

Phase 3 exposes an independently testable MCP server core through an injected transport. It does
not open a listener or implement the Brain WebSocket adapter. Only explicitly registered tools are
advertised. Filesystem tools operate inside human-approved directories, use read/action permissions,
refuse overwrites unless explicitly requested, require approval for actions and deletion, and record
operation metadata without file content. Filesystem tools are disabled unless an allowed-directory
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
both processes. It is disabled by default. Deletion additionally requires `confirmed: true`; recursive
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
approves only `process.start` and `process.terminate` and does not change filesystem or unrelated
action permissions. Process tools still require `GANGLION_PROCESS_MANAGEMENT` to be enabled, and
ProcessManager continues to enforce protected PIDs, PID/start-time identity checks, OS permissions,
and explicit signal selection. This is not a trusted approval UI and must not be used in production.
`clockTicksPerSecond` is optional, but Ganglion does not infer or assume its value. When omitted,
process inspection remains available and CPU usage is reported as unavailable. Set it to the value
verified for the host (for example, `getconf CLK_TCK` reports `100` on some Ubuntu systems; Ganglion
does not execute `getconf`). `sampleIntervalMs` defaults to 1000 ms. CPU percentages are per-core:
100% represents one logical CPU fully utilized and values can exceed 100% on multicore workloads.
The first sample establishes a baseline, so CPU remains unavailable until a subsequent sample.

The adapter exposes five tools: `process.list` lists visible processes, `process.get_info` retrieves
one process, `process.find` filters the list, `process.start` launches an arbitrary executable, and
`process.terminate` signals one specifically selected process. Name matching in `process.find` is
case-insensitive and partial; executable and username filters are exact. Filters combine with AND,
and the tool returns all matches rather than selecting one.

For termination, the expected agent workflow is discovery, presentation, user selection, then
termination: call `process.find`, show all matches to the user, and pass the selected result's `pid`
and `startTimeTicks` to `process.terminate`. PID alone is not accepted. The start-time identity lets
Ganglion reject a stale selection if the PID now belongs to a different process. It does not
eliminate the small race between the final `/proc` check and signaling; native pidfd support is not
implemented.

Process reads use the existing `read` permission. Start and termination use the existing `action`
permission and trusted, non-voice approval flow. Enabling this feature does not approve actions; the
development approval provider still only approves its existing `filesystem.*` scope. Starting
supports arbitrary executable names or paths and argument arrays, without a profile allowlist. It
does not use a shell, and `confined_process` is a capability label, not an OS sandbox. Arguments are
omitted from approval targets and child processes receive only `PATH`, not Ganglion's other
environment variables.

Termination is limited by the OS permissions of the user running Ganglion. PID 1, Ganglion itself,
Ganglion's ancestors, and configured `protectedPids` are protected. `SIGTERM` is the default;
`SIGKILL` is forceful and must be explicitly requested. Ganglion never escalates automatically.
Memory values use bytes: RSS is resident physical memory, virtual memory is address-space size, and
the percentage is RSS divided by total physical memory. Process inspection does not read process
environment variables.
