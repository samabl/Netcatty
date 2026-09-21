/**
 * Tool naming for external MCP servers.
 *
 * Third-party tool names must not collide with catalog tool names, and most
 * providers cap tool names at 64 characters. Names are built as
 * `mcp__<server>__<tool>` and uniquified deterministically.
 */

export const EXTERNAL_MCP_TOOL_PREFIX = 'mcp';
export const EXTERNAL_MCP_TOOL_NAME_MAX_LENGTH = 64;

const SEGMENT_MAX_LENGTH = 26;

/** `[a-z0-9_-]` only, collapsed, trimmed of separators. */
export function sanitizeExternalMcpSegment(value: string): string {
  const normalized = value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized || 'server';
}

function truncateSegment(segment: string): string {
  if (segment.length <= SEGMENT_MAX_LENGTH) return segment;
  return segment.slice(0, SEGMENT_MAX_LENGTH).replace(/_+$/g, '');
}

/** FNV-1a, base36. Stable across runs and platforms. */
function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7);
}

export interface ExternalMcpToolNameInput {
  serverId: string;
  serverName: string;
  toolName: string;
}

export interface ExternalMcpToolNameEntry extends ExternalMcpToolNameInput {
  qualifiedName: string;
}

export function buildExternalMcpToolName(serverKey: string, toolName: string): string {
  const serverSegment = truncateSegment(sanitizeExternalMcpSegment(serverKey));
  const toolSegment = truncateSegment(sanitizeExternalMcpSegment(toolName));
  const candidate = `${EXTERNAL_MCP_TOOL_PREFIX}__${serverSegment}__${toolSegment}`;
  if (candidate.length <= EXTERNAL_MCP_TOOL_NAME_MAX_LENGTH) return candidate;

  const hash = shortHash(`${serverKey}\u0000${toolName}`);
  const budget = EXTERNAL_MCP_TOOL_NAME_MAX_LENGTH
    - EXTERNAL_MCP_TOOL_PREFIX.length - 4 - hash.length
    - serverSegment.length;
  const clamped = toolSegment.slice(0, Math.max(1, budget)).replace(/_+$/g, '');
  return `${EXTERNAL_MCP_TOOL_PREFIX}__${serverSegment}__${clamped}_${hash}`;
}

/**
 * Assign a collision-free name to each descriptor. Duplicates (two servers
 * exposing the same sanitized tool name) get a numeric suffix in input order.
 */
export function assignExternalMcpToolNames(
  entries: readonly ExternalMcpToolNameInput[],
): ExternalMcpToolNameEntry[] {
  const used = new Set<string>();
  const out: ExternalMcpToolNameEntry[] = [];
  for (const entry of entries) {
    const base = buildExternalMcpToolName(entry.serverName || entry.serverId, entry.toolName);
    let qualifiedName = base;
    let suffix = 2;
    while (used.has(qualifiedName)) {
      const tail = `_${suffix}`;
      qualifiedName = `${base.slice(0, EXTERNAL_MCP_TOOL_NAME_MAX_LENGTH - tail.length)}${tail}`;
      suffix += 1;
    }
    used.add(qualifiedName);
    out.push({ ...entry, qualifiedName });
  }
  return out;
}

export function isExternalMcpQualifiedToolName(name: string): boolean {
  return name.startsWith(`${EXTERNAL_MCP_TOOL_PREFIX}__`);
}
