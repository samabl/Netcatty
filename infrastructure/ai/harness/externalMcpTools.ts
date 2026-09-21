import { jsonSchema, tool } from 'ai';
import type { ExternalMcpToolDescriptor } from '../mcp/externalMcpTypes';
import { getExternalMcpClientBridge } from '../mcp/externalMcpBridge';
import { normalizeExternalMcpInputSchema } from '../../../domain/mcp/externalMcpInputSchema';
import { assignExternalMcpToolNames } from '../../../domain/mcp/externalMcpToolName';
import { cattyToolContextSchema, type CattyToolContext } from './cattyRuntimeContext';
import { fitLargeToolResultForModel } from './toolResultFitting';
import type { CattyToolPolicy, CattyToolsBundle } from './capabilityTools';

/** Label used for tool-output handles produced by third-party MCP calls. */
export const EXTERNAL_MCP_CAPABILITY_ID = 'external-mcp.call';

/** Upper bound on third-party tools injected into a single turn. */
export const EXTERNAL_MCP_MAX_TOTAL_TOOLS = 128;

/**
 * Third-party tools are unvetted: they count as writes unless the user opted
 * the server into auto-approval. Observer mode therefore blocks them, and
 * confirm mode prompts exactly once per call.
 *
 * No fixed `capabilityId` is set on purpose: approval grants then fall back to
 * `resolveCapabilityId(toolName)`, which keys on the namespaced tool name. A
 * single "always allow" therefore covers one third-party tool, never every
 * tool from every server.
 */
export function resolveExternalMcpToolPolicy(descriptor: ExternalMcpToolDescriptor): CattyToolPolicy {
  return {
    write: true,
    bypassesApproval: descriptor.autoApprove === true,
    bypassesObserverBlock: false,
  };
}

function buildToolDescription(descriptor: ExternalMcpToolDescriptor): string {
  const server = descriptor.serverName || descriptor.serverId;
  const detail = descriptor.description.trim();
  const prefix = `[External MCP server: ${server}]`;
  return detail ? `${prefix} ${detail}` : prefix;
}

/** Normalize a main-process call result into the shape the model reads. */
export function normalizeExternalMcpCallResult(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== 'object') {
    return { error: 'External MCP tool returned an unexpected response.' };
  }
  const payload = result as { error?: unknown; result?: unknown; structuredContent?: unknown };
  if (typeof payload.error === 'string' && payload.error) {
    return { error: payload.error };
  }
  const out: Record<string, unknown> = { ok: true };
  if (typeof payload.result === 'string' && payload.result) out.result = payload.result;
  if (payload.structuredContent !== undefined) out.structuredContent = payload.structuredContent;
  if (out.result === undefined && out.structuredContent === undefined) {
    out.result = 'External MCP tool completed with no output.';
  }
  return out;
}

/**
 * Build AI SDK tools for the tools published by connected external MCP
 * servers. Names are namespaced (`mcp__<server>__<tool>`) so they can never
 * shadow a catalog tool.
 */
export function buildExternalMcpTools(
  descriptors: readonly ExternalMcpToolDescriptor[],
  sharedContext: CattyToolContext,
): CattyToolsBundle {
  const limited = descriptors.slice(0, EXTERNAL_MCP_MAX_TOTAL_TOOLS);
  const named = assignExternalMcpToolNames(limited.map((descriptor) => ({
    serverId: descriptor.serverId,
    serverName: descriptor.serverName || descriptor.serverId,
    toolName: descriptor.toolName,
  })));

  const builtTools: CattyToolsBundle['tools'] = {};
  const toolsContext: CattyToolsBundle['toolsContext'] = {};
  const policies: Record<string, CattyToolPolicy> = {};

  for (let index = 0; index < limited.length; index += 1) {
    const descriptor = limited[index];
    const qualifiedName = named[index].qualifiedName;
    if (builtTools[qualifiedName]) continue;

    // AI SDK v7 types `Tool` generically while `CattyToolsBundle` prefers the
    // catalog's concrete shape; the runtime value is identical.
    builtTools[qualifiedName] = tool({
      description: buildToolDescription(descriptor),
      inputSchema: jsonSchema<Record<string, unknown>>(
        normalizeExternalMcpInputSchema(descriptor.inputSchema),
      ),
      contextSchema: cattyToolContextSchema,
      execute: async (args, options) => {
        const context = options.context as CattyToolContext | undefined;
        if (options.abortSignal?.aborted) {
          return { error: 'Tool call cancelled before it could start.' };
        }
        const client = getExternalMcpClientBridge(context?.bridge ?? null);
        if (!client?.mcpClientCallTool) {
          return { error: 'External MCP client is unavailable in this environment.' };
        }
        const result = await client.mcpClientCallTool(
          descriptor.serverId,
          descriptor.toolName,
          (args ?? {}) as Record<string, unknown>,
        );
        return fitLargeToolResultForModel({
          result: normalizeExternalMcpCallResult(result),
          capabilityId: EXTERNAL_MCP_CAPABILITY_ID,
          chatSessionId: context?.chatSessionId,
          toolOutputStore: context?.toolOutputStore,
          normalizeStrings: true,
        });
      },
    }) as unknown as CattyToolsBundle['tools'][string];
    toolsContext[qualifiedName] = sharedContext;
    policies[qualifiedName] = resolveExternalMcpToolPolicy(descriptor);
  }

  return { tools: builtTools, toolsContext, policies };
}

/** Merge an extra bundle (external tools) over the catalog bundle. */
export function mergeCattyToolBundles(
  base: CattyToolsBundle,
  extra: CattyToolsBundle | null | undefined,
): CattyToolsBundle {
  if (!extra || Object.keys(extra.tools).length === 0) return base;
  return {
    tools: { ...base.tools, ...extra.tools },
    toolsContext: { ...base.toolsContext, ...extra.toolsContext },
    policies: { ...(base.policies ?? {}), ...(extra.policies ?? {}) },
  };
}

/** Servers contributing tools this turn, for the system prompt. */
export function summarizeExternalMcpServers(
  descriptors: readonly ExternalMcpToolDescriptor[],
): Array<{ name: string; toolCount: number; autoApprove: boolean }> {
  const byServer = new Map<string, { name: string; toolCount: number; autoApprove: boolean }>();
  for (const descriptor of descriptors) {
    const key = descriptor.serverId;
    const existing = byServer.get(key);
    if (existing) {
      existing.toolCount += 1;
      existing.autoApprove = existing.autoApprove && descriptor.autoApprove === true;
      continue;
    }
    byServer.set(key, {
      name: descriptor.serverName || descriptor.serverId,
      toolCount: 1,
      autoApprove: descriptor.autoApprove === true,
    });
  }
  return Array.from(byServer.values());
}
