import type { PermissionTier } from "./mcp/types.ts";

/**
 * Per-tool tier overrides a human set (G6.1, GANGLION_DECISIONS 9, 15, 35): `{ "tool.name": "read" |
 * "action" }`. Scoped auto mode, never global: a key must name one tool exactly, so there is no way
 * to write "approve everything". An override for a tool that does not exist does nothing.
 */
export type Tiers = Record<string, PermissionTier>;

const TOOL_NAME = /^[a-z0-9._-]+$/;

export function parseTiers(value: unknown): Tiers | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("tiers must be an object of tool name → read | action");
  const tiers: Tiers = {};
  for (const [name, tier] of Object.entries(value)) {
    if (!TOOL_NAME.test(name)) throw new Error(`tiers: "${name}" is not one tool's name (no wildcards, no blanket switch)`);
    if (tier !== "read" && tier !== "action") throw new Error(`tiers: ${name} must be "read" or "action"`);
    tiers[name] = tier;
  }
  return tiers;
}
