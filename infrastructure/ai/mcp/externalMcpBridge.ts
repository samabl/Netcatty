import type {
  ExternalMcpClientBridge,
  ExternalMcpServerStatus,
  ExternalMcpToolDescriptor,
} from './externalMcpTypes';

export type {
  ExternalMcpCallResult,
  ExternalMcpClientBridge,
  ExternalMcpServerState,
  ExternalMcpServerStatus,
  ExternalMcpToolDescriptor,
} from './externalMcpTypes';

/**
 * Narrow a bridge object to the MCP-client surface, or null when absent.
 * Typed structurally so both the global `window.netcatty` shape and the
 * agent's NetcattyBridge are accepted without a cast at call sites.
 */
export function getExternalMcpClientBridge(
  bridge?: ExternalMcpClientBridge | null,
): ExternalMcpClientBridge | null {
  if (!bridge) return null;
  const hasClientMethod = typeof bridge.mcpClientListTools === 'function'
    || typeof bridge.mcpClientCallTool === 'function'
    || typeof bridge.mcpClientGetStatus === 'function'
    || typeof bridge.mcpClientSetServers === 'function';
  return hasClientMethod ? bridge : null;
}

/** Push the desired server list to the main process. Never throws. */
export async function syncExternalMcpServers(
  bridge: ExternalMcpClientBridge | null | undefined,
  servers: unknown[],
): Promise<ExternalMcpServerStatus[]> {
  const client = getExternalMcpClientBridge(bridge);
  if (!client?.mcpClientSetServers) return [];
  try {
    const result = await client.mcpClientSetServers(servers);
    return result?.ok && Array.isArray(result.status) ? result.status : [];
  } catch {
    return [];
  }
}

/** Current per-server connection status. Never throws. */
export async function fetchExternalMcpStatus(
  bridge: ExternalMcpClientBridge | null | undefined,
): Promise<ExternalMcpServerStatus[]> {
  const client = getExternalMcpClientBridge(bridge);
  if (!client?.mcpClientGetStatus) return [];
  try {
    const result = await client.mcpClientGetStatus();
    return result?.ok && Array.isArray(result.status) ? result.status : [];
  } catch {
    return [];
  }
}

/**
 * Tools published by every connected server. A failing or unconfigured client
 * degrades to "no external tools" so a turn never dies because of MCP.
 */
export async function fetchExternalMcpTools(
  bridge: ExternalMcpClientBridge | null | undefined,
): Promise<ExternalMcpToolDescriptor[]> {
  const client = getExternalMcpClientBridge(bridge);
  if (!client?.mcpClientListTools) return [];
  try {
    const result = await client.mcpClientListTools();
    if (!result?.ok || !Array.isArray(result.tools)) return [];
    return result.tools.filter(
      (tool): tool is ExternalMcpToolDescriptor =>
        Boolean(tool)
        && typeof tool.serverId === 'string'
        && typeof tool.toolName === 'string',
    );
  } catch {
    return [];
  }
}
