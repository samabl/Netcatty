/**
 * External MCP server model (Netcatty acting as an MCP client).
 *
 * Third-party MCP servers are configured by the user in Settings -> AI and
 * become extra tools for the in-app sidebar agent. This module is pure: it
 * owns the shape, normalization and validation only. Connecting / spawning
 * lives in the Electron main process, persistence in application state.
 */

export type ExternalMcpTransport = 'stdio' | 'http' | 'sse';

export interface ExternalMcpKeyValue {
  name: string;
  value: string;
}

export interface ExternalMcpServer {
  id: string;
  name: string;
  enabled: boolean;
  transport: ExternalMcpTransport;
  /** stdio transport */
  command?: string;
  args?: string[];
  cwd?: string;
  env?: ExternalMcpKeyValue[];
  /** http / sse transports */
  url?: string;
  headers?: ExternalMcpKeyValue[];
  /**
   * Server-level opt-in to skip the per-call approval prompt. Off by default:
   * third-party tools are unvetted, so confirm mode asks and observer blocks.
   */
  autoApprove?: boolean;
  /** Restrict exposure to these tool names; empty/absent exposes every tool. */
  toolAllowlist?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export const EXTERNAL_MCP_TRANSPORTS: readonly ExternalMcpTransport[] = ['stdio', 'http', 'sse'];

export const EXTERNAL_MCP_SERVER_NAME_MAX_LENGTH = 64;
export const EXTERNAL_MCP_KEY_VALUE_MAX_ENTRIES = 64;
export const EXTERNAL_MCP_TOOL_ALLOWLIST_MAX_ENTRIES = 256;

export type ExternalMcpValidationError =
  | 'name-required'
  | 'command-required'
  | 'url-required'
  | 'url-invalid';

const TRANSPORT_SET: ReadonlySet<string> = new Set(EXTERNAL_MCP_TRANSPORTS);

const REDACTED = '***';

export function isExternalMcpTransport(value: unknown): value is ExternalMcpTransport {
  return typeof value === 'string' && TRANSPORT_SET.has(value);
}

export function createExternalMcpServerId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `mcp-${cryptoApi.randomUUID()}`;
  }
  return `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function trimmedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

function normalizeStringList(value: unknown, maxEntries: number): string[] {
  const raw = Array.isArray(value) ? value : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= maxEntries) break;
  }
  return out;
}

/**
 * Accept either an ordered `[{ name, value }]` list or a plain object map so
 * users can paste a conventional `mcpServers` JSON fragment.
 */
export function normalizeExternalMcpKeyValues(value: unknown): ExternalMcpKeyValue[] {
  const out: ExternalMcpKeyValue[] = [];
  const seen = new Set<string>();
  const push = (name: unknown, entryValue: unknown) => {
    if (out.length >= EXTERNAL_MCP_KEY_VALUE_MAX_ENTRIES) return;
    if (typeof name !== 'string') return;
    const key = name.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ name: key, value: typeof entryValue === 'string' ? entryValue : String(entryValue ?? '') });
  };

  if (Array.isArray(value)) {
    for (const entry of value) {
      const record = asRecord(entry);
      if (!record) continue;
      push(record.name, record.value);
    }
    return out;
  }

  const record = asRecord(value);
  if (record) {
    for (const [key, entryValue] of Object.entries(record)) push(key, entryValue);
  }
  return out;
}

function deriveServerName(record: Record<string, unknown>): string {
  const explicit = trimmedString(record.name, EXTERNAL_MCP_SERVER_NAME_MAX_LENGTH);
  if (explicit) return explicit;
  const command = trimmedString(record.command, 256);
  if (command) {
    const base = command.replace(/\\/g, '/').split('/').pop() ?? command;
    return trimmedString(base.replace(/\.(cmd|exe|js|cjs|mjs|py|sh)$/i, ''), EXTERNAL_MCP_SERVER_NAME_MAX_LENGTH);
  }
  const url = trimmedString(record.url, 2048);
  if (url) {
    try {
      return trimmedString(new URL(url).host, EXTERNAL_MCP_SERVER_NAME_MAX_LENGTH);
    } catch {
      return trimmedString(url, EXTERNAL_MCP_SERVER_NAME_MAX_LENGTH);
    }
  }
  return '';
}

/**
 * Coerce an unknown record into a usable server config. Returns null when the
 * entry cannot be identified at all (no name, no command, no url).
 */
export function sanitizeExternalMcpServer(
  raw: unknown,
  options: { fallbackId?: string; now?: number } = {},
): ExternalMcpServer | null {
  const record = asRecord(raw);
  if (!record) return null;

  const transport = isExternalMcpTransport(record.transport) ? record.transport : 'stdio';
  const name = deriveServerName(record);
  if (!name) return null;

  const id = trimmedString(record.id, 128) || options.fallbackId || createExternalMcpServerId();
  const server: ExternalMcpServer = {
    id,
    name,
    enabled: record.enabled !== false,
    transport,
  };

  if (transport === 'stdio') {
    const command = trimmedString(record.command, 512);
    if (command) server.command = command;
    const args = normalizeStringList(record.args, 64);
    if (args.length) server.args = args;
    const cwd = trimmedString(record.cwd, 512);
    if (cwd) server.cwd = cwd;
    const env = normalizeExternalMcpKeyValues(record.env);
    if (env.length) server.env = env;
  } else {
    const url = trimmedString(record.url, 2048);
    if (url) server.url = url;
    const headers = normalizeExternalMcpKeyValues(record.headers);
    if (headers.length) server.headers = headers;
  }

  if (record.autoApprove === true) server.autoApprove = true;
  const toolAllowlist = normalizeStringList(
    record.toolAllowlist,
    EXTERNAL_MCP_TOOL_ALLOWLIST_MAX_ENTRIES,
  );
  if (toolAllowlist.length) server.toolAllowlist = toolAllowlist;

  const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt)
    ? record.createdAt
    : options.now;
  if (createdAt !== undefined) server.createdAt = createdAt;
  const updatedAt = typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
    ? record.updatedAt
    : undefined;
  if (updatedAt !== undefined) server.updatedAt = updatedAt;

  return server;
}

/** Normalize a persisted list, dropping unidentifiable entries and duplicate ids. */
export function sanitizeExternalMcpServers(raw: unknown, options: { now?: number } = {}): ExternalMcpServer[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: ExternalMcpServer[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const server = sanitizeExternalMcpServer(entry, { now: options.now });
    if (!server || seen.has(server.id)) continue;
    seen.add(server.id);
    out.push(server);
  }
  return out;
}

export function validateExternalMcpServer(server: ExternalMcpServer): ExternalMcpValidationError[] {
  const errors: ExternalMcpValidationError[] = [];
  if (!server.name.trim()) errors.push('name-required');

  if (server.transport === 'stdio') {
    if (!server.command?.trim()) errors.push('command-required');
  } else {
    const url = server.url?.trim() ?? '';
    if (!url) {
      errors.push('url-required');
    } else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') errors.push('url-invalid');
      } catch {
        errors.push('url-invalid');
      }
    }
  }
  return errors;
}

export function isExternalMcpServerRunnable(server: ExternalMcpServer): boolean {
  return server.enabled && validateExternalMcpServer(server).length === 0;
}

/** Secret-bearing values replaced, for logs / traces / bug reports. */
export function redactExternalMcpServer(server: ExternalMcpServer): ExternalMcpServer {
  const redact = (entries?: ExternalMcpKeyValue[]): ExternalMcpKeyValue[] | undefined =>
    entries?.map((entry) => ({ name: entry.name, value: entry.value ? REDACTED : '' }));
  return {
    ...server,
    env: redact(server.env),
    headers: redact(server.headers),
  };
}
