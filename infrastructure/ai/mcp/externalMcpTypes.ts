/**
 * Shared types for the external MCP client (Netcatty calling third-party MCP
 * servers). Kept dependency-free so both the agent bridge interface and the
 * renderer-side client can import it without a cycle.
 */

export interface ExternalMcpToolDescriptor {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Server declared the tool as read-only; informational only. */
  readOnlyHint?: boolean;
  /** Server opted out of per-call approval. */
  autoApprove?: boolean;
}

export type ExternalMcpServerState = 'disabled' | 'connecting' | 'connected' | 'error';

export interface ExternalMcpServerStatus {
  id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  enabled: boolean;
  state: ExternalMcpServerState;
  toolCount: number;
  error: string | null;
}

export interface ExternalMcpCallResult {
  ok?: boolean;
  result?: string;
  structuredContent?: unknown;
  error?: string;
}

/** Optional subset of `window.electron` used to reach the main-process client. */
export interface ExternalMcpClientBridge {
  mcpClientSetServers?: (servers: unknown[]) => Promise<{
    ok: boolean;
    status?: ExternalMcpServerStatus[];
    error?: string;
  }>;
  mcpClientGetStatus?: () => Promise<{
    ok: boolean;
    status?: ExternalMcpServerStatus[];
    error?: string;
  }>;
  mcpClientListTools?: () => Promise<{
    ok: boolean;
    tools?: ExternalMcpToolDescriptor[];
    error?: string;
  }>;
  mcpClientCallTool?: (
    serverId: string,
    toolName: string,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ) => Promise<ExternalMcpCallResult>;
}
