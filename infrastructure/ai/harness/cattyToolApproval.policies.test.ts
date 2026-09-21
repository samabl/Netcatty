import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCattyToolApproval, resolveCattyToolPolicy } from './cattyToolApproval.ts';

type ApprovalInput = {
  toolCall: { toolCallId: string; toolName: string; input?: Record<string, unknown> };
};
type ApprovalFn = (input: ApprovalInput) => Promise<unknown>;

const EXTERNAL_POLICY = {
  write: true,
  bypassesApproval: false,
  bypassesObserverBlock: false,
};

/**
 * AI SDK v7's ToolApprovalConfiguration is not a plain callable type, so the
 * builder's return value is narrowed here for the test call sites.
 */
function approvalFor(
  input: Parameters<typeof buildCattyToolApproval>[0],
): ApprovalFn {
  return buildCattyToolApproval(input) as unknown as ApprovalFn;
}

function call(toolName: string, input: Record<string, unknown> = {}): ApprovalInput {
  return { toolCall: { toolCallId: 'call-1', toolName, input } };
}

test('resolveCattyToolPolicy prefers an explicit override over the catalog spec', () => {
  assert.equal(
    resolveCattyToolPolicy('sftp_write_file', { sftp_write_file: EXTERNAL_POLICY }),
    EXTERNAL_POLICY,
  );
  // Catalog fallback still applies when no override is present.
  assert.equal(resolveCattyToolPolicy('sftp_write_file', {})?.write, true);
  assert.equal(resolveCattyToolPolicy('mcp__files__read', undefined), undefined);
});

test('external MCP tools are denied in observer mode', async () => {
  const approval = approvalFor({
    permissionMode: 'observer',
    chatSessionId: 'chat-1',
    policies: { mcp__files__read: EXTERNAL_POLICY },
  });
  assert.deepEqual(await approval(call('mcp__files__read')), {
    type: 'denied',
    reason: 'Observer mode blocks write operations.',
  });
});

test('external MCP tools prompt once in confirm mode, scoped to the tool itself', async () => {
  const seen: Array<{ toolName: string; capabilityId?: string }> = [];
  const approval = approvalFor({
    permissionMode: 'confirm',
    chatSessionId: 'chat-1',
    policies: { mcp__files__read: EXTERNAL_POLICY },
    requestApproval: async (_toolCallId, toolName, _args, _chatSessionId, _type, capabilityId) => {
      seen.push({ toolName, capabilityId });
      return true;
    },
  });
  assert.deepEqual(await approval(call('mcp__files__read', { path: '/x' })), { type: 'approved' });
  // A fixed capability id would let one grant cover every third-party tool, so
  // the grant key must stay the namespaced tool name.
  assert.deepEqual(seen, [{ toolName: 'mcp__files__read', capabilityId: 'mcp__files__read' }]);
});

test('auto-approved external servers skip the prompt but stay blocked for observers', async () => {
  const policy = { ...EXTERNAL_POLICY, bypassesApproval: true };
  let prompted = false;
  const approval = approvalFor({
    permissionMode: 'confirm',
    chatSessionId: 'chat-1',
    policies: { mcp__files__read: policy },
    requestApproval: async () => {
      prompted = true;
      return true;
    },
  });
  assert.equal(await approval(call('mcp__files__read')), undefined);
  assert.equal(prompted, false);

  const observer = approvalFor({
    permissionMode: 'observer',
    chatSessionId: 'chat-1',
    policies: { mcp__files__read: policy },
  });
  assert.deepEqual(await observer(call('mcp__files__read')), {
    type: 'denied',
    reason: 'Observer mode blocks write operations.',
  });
});

test('catalog tools keep their own policy when external policies are present', async () => {
  const approval = approvalFor({
    permissionMode: 'observer',
    chatSessionId: 'chat-1',
    policies: { mcp__files__read: EXTERNAL_POLICY },
  });
  // terminal_stop is a catalog tool with bypassesObserverBlock.
  assert.equal(await approval(call('terminal_stop', { jobId: 'job-1' })), undefined);
  // Unknown non-catalog tool with no policy is left ungated.
  assert.equal(await approval(call('mcp__unknown__tool')), undefined);
});
