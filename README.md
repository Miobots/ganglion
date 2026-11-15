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
