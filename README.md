# miobots-ganglion

See `CLAUDE.md` for the rules that apply here.

```bash
bun install
bun start
```

Bun, one lockfile, one pinned TypeScript — the same toolchain as `miobots-brain` and
`miobots-protocol` (BRAIN_DECISIONS 21).

Design documentation is in the Obsidian vault two levels up.

**Status: scaffold only, deliberately.** The system must work fully without this daemon, and it is built last — see `CLAUDE.md`.

Phase 3 exposes an independently testable MCP server core through an injected transport. It does
not open a listener or implement the Brain WebSocket adapter. Only explicitly registered tools are
advertised. Filesystem tools operate inside human-approved directories, use read/action permissions,
refuse overwrites, require approval for deletion, and record operation metadata without file content.
