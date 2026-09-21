import {
  type ExternalMcpKeyValue,
  type ExternalMcpServer,
  type ExternalMcpTransport,
  type ExternalMcpValidationError,
  validateExternalMcpServer,
} from '../../../../domain/mcp/externalMcpServer';

/**
 * Form <-> model helpers for the external MCP server editor. Kept free of
 * React so the parsing rules can be unit tested directly.
 */
export interface ExternalMcpFormValues {
  id: string;
  name: string;
  enabled: boolean;
  transport: ExternalMcpTransport;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  url: string;
  headersText: string;
  autoApprove: boolean;
  toolAllowlistText: string;
}

/** `KEY=value` per line; blank lines and `#` comments are ignored. */
export function parseKeyValueLines(text: string): ExternalMcpKeyValue[] {
  const out: ExternalMcpKeyValue[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    const name = (separator === -1 ? line : line.slice(0, separator)).trim();
    const value = separator === -1 ? '' : line.slice(separator + 1).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value });
  }
  return out;
}

export function formatKeyValueLines(entries?: ExternalMcpKeyValue[]): string {
  if (!entries?.length) return '';
  return entries.map((entry) => `${entry.name}=${entry.value}`).join('\n');
}

/** One entry per line. */
export function parseListLines(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

export function formatListLines(list?: string[]): string {
  return list?.length ? list.join('\n') : '';
}

export function toFormValues(server: ExternalMcpServer): ExternalMcpFormValues {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    command: server.command ?? '',
    argsText: formatListLines(server.args),
    cwd: server.cwd ?? '',
    envText: formatKeyValueLines(server.env),
    url: server.url ?? '',
    headersText: formatKeyValueLines(server.headers),
    autoApprove: server.autoApprove === true,
    toolAllowlistText: formatListLines(server.toolAllowlist),
  };
}

export function createEmptyFormValues(id: string): ExternalMcpFormValues {
  return {
    id,
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    argsText: '',
    cwd: '',
    envText: '',
    url: '',
    headersText: '',
    autoApprove: false,
    toolAllowlistText: '',
  };
}

export function fromFormValues(values: ExternalMcpFormValues, now = Date.now()): ExternalMcpServer {
  const server: ExternalMcpServer = {
    id: values.id,
    name: values.name.trim(),
    enabled: values.enabled,
    transport: values.transport,
    createdAt: now,
    updatedAt: now,
  };

  if (values.transport === 'stdio') {
    const command = values.command.trim();
    if (command) server.command = command;
    const args = parseListLines(values.argsText);
    if (args.length) server.args = args;
    const cwd = values.cwd.trim();
    if (cwd) server.cwd = cwd;
    const env = parseKeyValueLines(values.envText);
    if (env.length) server.env = env;
  } else {
    const url = values.url.trim();
    if (url) server.url = url;
    const headers = parseKeyValueLines(values.headersText);
    if (headers.length) server.headers = headers;
  }

  if (values.autoApprove) server.autoApprove = true;
  const allowlist = parseListLines(values.toolAllowlistText);
  if (allowlist.length) server.toolAllowlist = allowlist;

  return server;
}

/** i18n key for each domain validation error. */
export const EXTERNAL_MCP_VALIDATION_MESSAGE_KEY: Record<ExternalMcpValidationError, string> = {
  'name-required': 'ai.mcpServers.error.nameRequired',
  'command-required': 'ai.mcpServers.error.commandRequired',
  'url-required': 'ai.mcpServers.error.urlRequired',
  'url-invalid': 'ai.mcpServers.error.urlInvalid',
};

/** Validate form input by round-tripping through the domain model. */
export function validateFormValues(values: ExternalMcpFormValues): ExternalMcpValidationError[] {
  return validateExternalMcpServer(fromFormValues(values));
}
