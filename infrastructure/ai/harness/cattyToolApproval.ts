import type { ToolApprovalConfiguration } from 'ai';
import type { AIPermissionMode } from '../types';
import { requestApproval as defaultRequestApproval } from '../shared/approvalGate';
import { resolveCapabilityId } from './permissionGrants';
import cattyToolSpecs from './generated/cattyToolSpecs.json';
import type { CattyToolPolicy } from './capabilityTools';

type CattyToolPolicySpec = {
  toolName: string;
  capabilityId: string;
  policy: CattyToolPolicy;
};

const policyByToolName = new Map<string, CattyToolPolicySpec>(
  (cattyToolSpecs as CattyToolPolicySpec[]).map((spec) => [spec.toolName, spec]),
);

/**
 * Resolve the approval policy for a tool. An explicit override (tools from
 * external MCP servers, which are not in the generated catalog) wins over the
 * catalog spec so a same-named third-party tool can never self-approve.
 */
export function resolveCattyToolPolicy(
  toolName: string,
  policies?: Record<string, CattyToolPolicy>,
): CattyToolPolicy | undefined {
  return policies?.[toolName] ?? policyByToolName.get(toolName)?.policy;
}

export function buildCattyToolApproval(input: {
  permissionMode: AIPermissionMode;
  chatSessionId?: string;
  requestApproval?: typeof defaultRequestApproval;
  /** Per-turn policy overrides, keyed by tool name. */
  policies?: Record<string, CattyToolPolicy>;
}): ToolApprovalConfiguration<Record<string, never>, import('./cattyRuntimeContext').CattyRuntimeContext> {
  const { permissionMode, chatSessionId, requestApproval = defaultRequestApproval, policies } = input;

  return async ({ toolCall }) => {
    const policy = resolveCattyToolPolicy(toolCall.toolName, policies);
    if (!policy?.write) {
      return undefined;
    }

    if (permissionMode === 'observer' && !policy.bypassesObserverBlock) {
      return { type: 'denied' as const, reason: 'Observer mode blocks write operations.' };
    }

    if (permissionMode !== 'confirm' || policy.bypassesApproval) {
      return undefined;
    }

    const args = (toolCall.input ?? {}) as Record<string, unknown>;
    const approved = await requestApproval(
      toolCall.toolCallId,
      toolCall.toolName,
      args,
      chatSessionId,
      undefined,
      policy.capabilityId ?? resolveCapabilityId(toolCall.toolName),
    );

    if (approved) {
      return { type: 'approved' as const };
    }
    return { type: 'denied' as const, reason: 'User denied tool execution.' };
  };
}
