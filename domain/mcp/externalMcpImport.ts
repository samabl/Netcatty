/**
 * Import third-party MCP server definitions from a JSON document.
 *
 * Netcatty persists its own list as an array of ExternalMcpServer, but users
 * usually arrive with an "mcpServers" object (Claude Desktop, Cursor, Cline,
 * Windsurf), a "servers" object (VS Code .vscode/mcp.json), or a single server
 * record. This module is pure: it recognizes those shapes, converts each entry
 * into the domain model, and reports what it skipped. Connecting / spawning a
 * server stays in the Electron main process, persistence in application state.
 */

import {
  createExternalMcpServerId,
  sanitizeExternalMcpServer,
  validateExternalMcpServer,
  type ExternalMcpServer,
  type ExternalMcpTransport,
} from './externalMcpServer';

/** Bound one import so a huge or hostile document cannot flood the settings list. */
export const EXTERNAL_MCP_IMPORT_MAX_SERVERS = 200;

export type ExternalMcpImportError = 'invalid-json' | 'unsupported-shape';

export type ExternalMcpImportSkipReason = 'invalid-entry' | 'limit-reached';

export interface ExternalMcpImportSkipped {
  /** Server name from the document; empty when the entry was unnamed. */
  name: string;
  reason: ExternalMcpImportSkipReason;
}

export type ExternalMcpImportActionKind = 'add' | 'update';

/**
 * One planned change. An entry whose name matches a configured server becomes
 * an update so the id (and therefore the tool namespace and connection status)
 * stays stable instead of accumulating duplicates.
 */
export interface ExternalMcpImportAction {
  kind: ExternalMcpImportActionKind;
  /** Server to persist; for updates it already carries the target id. */
  server: ExternalMcpServer;
  /** Id of the replaced entry; present only for updates. */
  targetId?: string;
}

export interface ExternalMcpImportResult {
  /** Planned add / update operations in document order. */
  actions: ExternalMcpImportAction[];
  skipped: ExternalMcpImportSkipped[];
  error: ExternalMcpImportError | null;
}

/**
 * Transport spellings seen across clients. Keys are lower-cased; unknown
 * values fall through so command / url can infer the transport instead.
 */
const TRANSPORT_ALIASES: Readonly<Record<string, ExternalMcpTransport>> = {
  stdio: 'stdio',
  http: 'http',
  'streamable-http': 'http',
  streamablehttp: 'http',
  streamable_http: 'http',
  sse: 'sse',
};

interface RawEntry {
  /** Name implied by the enclosing map key; empty for array / single entries. */
  key: string;
  record: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Case-insensitive identity used only to match a document entry to a server. */
function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

/** Map or array of named server records; null when the value is neither. */
function readNamedEntries(value: unknown): RawEntry[] | null {
  if (Array.isArray(value)) {
    const entries: RawEntry[] = [];
    for (const item of value) {
      const record = asRecord(item);
      if (!record) continue;
      entries.push({ key: nonEmptyString(record.name) ?? '', record });
    }
    return entries;
  }

  const record = asRecord(value);
  if (!record) return null;
  const entries: RawEntry[] = [];
  for (const [key, item] of Object.entries(record)) {
    if (key.startsWith('$')) continue;
    const entry = asRecord(item);
    if (!entry) continue;
    entries.push({ key, record: entry });
  }
  return entries;
}

/** True when a record is itself a server config rather than a name -> config map. */
function looksLikeServerRecord(record: Record<string, unknown>): boolean {
  return typeof record.command === 'string'
    || typeof record.url === 'string'
    || typeof record.serverUrl === 'string'
    || typeof record.transport === 'string'
    || typeof record.type === 'string';
}

/**
 * Find the server entries in any supported document. Returns null when the
 * document holds no recognizable definitions at all.
 */
function readDocumentEntries(parsed: unknown): RawEntry[] | null {
  if (Array.isArray(parsed)) return readNamedEntries(parsed);

  const record = asRecord(parsed);
  if (!record) return null;

  // Claude Desktop / Cursor / Cline wrappers, then VS Code "mcp.servers".
  for (const wrapper of ['mcpServers', 'servers']) {
    if (Object.prototype.hasOwnProperty.call(record, wrapper)) {
      return readNamedEntries(record[wrapper]);
    }
  }
  const mcp = asRecord(record.mcp);
  if (mcp && Object.prototype.hasOwnProperty.call(mcp, 'servers')) {
    return readNamedEntries(mcp.servers);
  }

  if (looksLikeServerRecord(record)) {
    return [{ key: nonEmptyString(record.name) ?? '', record }];
  }

  // Bare name -> config map.
  return readNamedEntries(record);
}

function readTransport(record: Record<string, unknown>): ExternalMcpTransport | null {
  for (const key of ['transport', 'type']) {
    const raw = nonEmptyString(record[key]);
    if (!raw) continue;
    const alias = TRANSPORT_ALIASES[raw.toLowerCase()];
    if (alias) return alias;
  }
  return null;
}

function inferTransport(record: Record<string, unknown>): ExternalMcpTransport {
  const explicit = readTransport(record);
  if (explicit) return explicit;
  if (nonEmptyString(record.command)) return 'stdio';
  if (nonEmptyString(record.url) || nonEmptyString(record.serverUrl)) return 'http';
  return 'stdio';
}

/**
 * Convert one document entry to a validated server, or null when it cannot be
 * identified. Ids are always re-minted so importing never rebinds an existing
 * entry; a same-name match is turned into an update afterwards.
 */
function buildServer(entry: RawEntry, now: number): ExternalMcpServer | null {
  const { record } = entry;
  const explicitName = nonEmptyString(record.name) ?? entry.key;
  const url = nonEmptyString(record.url) ?? nonEmptyString(record.serverUrl);
  const disabled = record.disabled === true;

  const server = sanitizeExternalMcpServer(
    {
      ...record,
      id: undefined,
      name: explicitName,
      transport: inferTransport(record),
      enabled: disabled ? false : record.enabled !== false,
      ...(url ? { url } : {}),
    },
    { now, fallbackId: createExternalMcpServerId() },
  );

  if (!server) return null;
  if (validateExternalMcpServer(server).length > 0) return null;
  return server;
}

/**
 * Merge a document entry over the server it replaces: the JSON owns every
 * connection field (so a changed transport drops stale command / env), while
 * identity (id and display name), createdAt and the local enabled toggle stay
 * with the existing entry.
 */
function buildUpdate(
  parsed: ExternalMcpServer,
  existing: ExternalMcpServer,
  now: number,
): ExternalMcpServer {
  return {
    ...parsed,
    id: existing.id,
    name: existing.name,
    createdAt: existing.createdAt,
    enabled: existing.enabled,
    updatedAt: now,
  };
}

/**
 * Parse a JSON document into an import plan.
 *
 * Supported shapes: Netcatty's own array export, { mcpServers: {...} },
 * { servers: {...} }, { mcp: { servers: {...} } }, a bare name -> config map,
 * and a single server record. A name that already exists becomes an update in
 * place; a name repeated inside the document keeps the last definition.
 */
export function parseExternalMcpServerImport(
  text: string,
  options: { existing?: readonly ExternalMcpServer[]; now?: number } = {},
): ExternalMcpImportResult {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) return { actions: [], skipped: [], error: 'invalid-json' };

  let parsedDocument: unknown;
  try {
    parsedDocument = JSON.parse(trimmed);
  } catch {
    return { actions: [], skipped: [], error: 'invalid-json' };
  }

  const entries = readDocumentEntries(parsedDocument);
  if (!entries || entries.length === 0) {
    return { actions: [], skipped: [], error: 'unsupported-shape' };
  }

  const now = options.now ?? Date.now();
  const existingByKey = new Map<string, ExternalMcpServer>();
  for (const server of options.existing ?? []) {
    const key = nameKey(server.name);
    if (key && !existingByKey.has(key)) existingByKey.set(key, server);
  }

  // Keyed by normalized name so a repeated definition overwrites the plan for
  // that name (Map keeps first-seen order).
  const planned = new Map<string, ExternalMcpImportAction>();
  const skipped: ExternalMcpImportSkipped[] = [];

  for (const entry of entries) {
    const label = nonEmptyString(entry.record.name) ?? entry.key;
    if (planned.size >= EXTERNAL_MCP_IMPORT_MAX_SERVERS) {
      skipped.push({ name: label, reason: 'limit-reached' });
      continue;
    }

    const server = buildServer(entry, now);
    if (!server) {
      skipped.push({ name: label, reason: 'invalid-entry' });
      continue;
    }

    const key = nameKey(server.name);
    if (!key) {
      skipped.push({ name: server.name, reason: 'invalid-entry' });
      continue;
    }

    const existing = existingByKey.get(key);
    planned.set(
      key,
      existing
        ? { kind: 'update', targetId: existing.id, server: buildUpdate(server, existing, now) }
        : { kind: 'add', server },
    );
  }

  return { actions: [...planned.values()], skipped, error: null };
}

/**
 * Apply an import plan to the current list. Updates replace the target entry in
 * place (keeping its position) so the visible order is not reshuffled; an
 * update whose target disappeared falls back to an append. Pure: returns a new
 * array.
 */
export function applyExternalMcpImport(
  existing: readonly ExternalMcpServer[],
  actions: readonly ExternalMcpImportAction[],
): ExternalMcpServer[] {
  const next = [...existing];
  const indexById = new Map<string, number>();
  next.forEach((server, index) => {
    if (!indexById.has(server.id)) indexById.set(server.id, index);
  });

  for (const action of actions) {
    const targetIndex = action.kind === 'update' && action.targetId
      ? indexById.get(action.targetId)
      : undefined;
    if (targetIndex !== undefined) {
      next[targetIndex] = action.server;
      continue;
    }
    next.push(action.server);
    indexById.set(action.server.id, next.length - 1);
  }

  return next;
}
