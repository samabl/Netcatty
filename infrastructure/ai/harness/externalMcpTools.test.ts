import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTERNAL_MCP_MAX_TOTAL_TOOLS,
  buildExternalMcpTools,
  mergeCattyToolBundles,
  normalizeExternalMcpCallResult,
  resolveExternalMcpToolPolicy,
  summarizeExternalMcpServers,
} from './externalMcpTools.ts';
import type { CattyToolsBundle } from './capabilityTools.ts';
import type { CattyToolContext } from './cattyRuntimeContext.ts';
import type { ExternalMcpToolDescriptor } from '../mcp/externalMcpTypes.ts';

type ToolResult = { ok?: boolean; result?: string; error?: string; structuredContent?: unknown };

function makeContext(
  callTool?: (serverId: string, toolName: string, args?: Record<string, unknown>) => Promise<unknown>,
): CattyToolContext {
  const bridge = {
    mcpClientCallTool: callTool
      ? (serverId: string, toolName: string, args?: Record<string, unknown>) => callTool(serverId, toolName, args)
      : undefined,
  } as unknown as CattyToolContext['bridge'];
  return {
    bridge,
    permissionMode: 'confirm',
    chatSessionId: 'chat-1',
    getExecutorContext: () => ({ sessions: [] }),
  };
}

function descriptor(overrides: Partial<ExternalMcpToolDescriptor> = {}): ExternalMcpToolDescriptor {
  return {
    serverId: 's1',
    serverName: 'Files',
    toolName: 'read',
    description: 'Read a file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    ...overrides,
  };
}

/**
 * AI SDK v7 types Tool generically, which the shared withCattyToolContext
 * helper (typed for the concrete catalog tools) cannot express. Invoke the
 * runtime execute through an explicit options shape instead.
 */
async function callTool(
  bundle: CattyToolsBundle,
  toolName: string,
  context: CattyToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const built = bundle.tools[toolName] as unknown as {
    execute?: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<ToolResult>;
  };
  assert.ok(built.execute, toolName + ' should expose execute');
  return built.execute(args, { toolCallId: 'call-1', messages: [], context });
}

test('buildExternalMcpTools namespaces tool names and tags the description', () => {
  const context = makeContext();
  const bundle = buildExternalMcpTools([descriptor()], context);
  const built = bundle.tools['mcp__files__read'];
  assert.ok(built);
  // AI SDK types allow a function description; this builder always sets text.
  const description = typeof built.description === 'string' ? built.description : '';
  assert.match(description, /\[External MCP server: Files\]/);
  assert.match(description, /Read a file/);
  assert.equal(bundle.toolsContext['mcp__files__read'], context);
});

test('buildExternalMcpTools never lets two servers claim the same tool name', () => {
  const bundle = buildExternalMcpTools(
    [descriptor(), descriptor({ serverId: 's2' })],
    makeContext(),
  );
  assert.deepEqual(Object.keys(bundle.tools).sort(), ['mcp__files__read', 'mcp__files__read_2']);
});

test('buildExternalMcpTools caps the number of injected tools', () => {
  const many = Array.from({ length: EXTERNAL_MCP_MAX_TOTAL_TOOLS + 25 }, (_value, index) =>
    descriptor({ toolName: 'tool_' + index }));
  const bundle = buildExternalMcpTools(many, makeContext());
  assert.equal(Object.keys(bundle.tools).length, EXTERNAL_MCP_MAX_TOTAL_TOOLS);
});

test('resolveExternalMcpToolPolicy treats third-party tools as writes requiring approval', () => {
  const strict = resolveExternalMcpToolPolicy(descriptor());
  assert.deepEqual(strict, {
    write: true,
    bypassesApproval: false,
    bypassesObserverBlock: false,
  });

  const trusted = resolveExternalMcpToolPolicy(descriptor({ autoApprove: true }));
  assert.equal(trusted.bypassesApproval, true);
  // Auto-approval must not also punch through observer mode.
  assert.equal(trusted.bypassesObserverBlock, false);
});

test('execute forwards the unqualified tool name and returns the result', async () => {
  const calls: Array<{ serverId: string; toolName: string; args?: Record<string, unknown> }> = [];
  const context = makeContext(async (serverId, toolName, args) => {
    calls.push({ serverId, toolName, args });
    return { ok: true, result: 'file body' };
  });

  const bundle = buildExternalMcpTools([descriptor()], context);
  const result = await callTool(bundle, 'mcp__files__read', context, { path: '/tmp/a' });

  assert.deepEqual(calls, [{ serverId: 's1', toolName: 'read', args: { path: '/tmp/a' } }]);
  assert.equal(result.ok, true);
  assert.equal(result.result, 'file body');
});

test('execute surfaces server errors and missing bridges', async () => {
  const failingContext = makeContext(async () => ({ error: 'server exploded' }));
  const failing = buildExternalMcpTools([descriptor()], failingContext);
  const failure = await callTool(failing, 'mcp__files__read', failingContext, { path: '/tmp/a' });
  assert.equal(failure.error, 'server exploded');

  const bareContext = makeContext();
  const unavailable = buildExternalMcpTools([descriptor()], bareContext);
  const missing = await callTool(unavailable, 'mcp__files__read', bareContext, { path: '/tmp/a' });
  assert.match(String(missing.error), /unavailable in this environment/);
});

test('normalizeExternalMcpCallResult maps transport payloads to model output', () => {
  assert.deepEqual(normalizeExternalMcpCallResult({ ok: true, result: 'done' }), { ok: true, result: 'done' });
  assert.deepEqual(normalizeExternalMcpCallResult({ error: 'nope' }), { error: 'nope' });
  assert.deepEqual(
    normalizeExternalMcpCallResult({ structuredContent: { count: 2 } }),
    { ok: true, structuredContent: { count: 2 } },
  );
  assert.deepEqual(normalizeExternalMcpCallResult(undefined), {
    error: 'External MCP tool returned an unexpected response.',
  });
  assert.match(
    String((normalizeExternalMcpCallResult({}) as { result?: string }).result),
    /no output/,
  );
});

test('mergeCattyToolBundles keeps catalog tools and returns base for empty extras', () => {
  const base = { tools: { terminal_execute: {} }, toolsContext: {}, policies: {} } as unknown as CattyToolsBundle;
  assert.equal(mergeCattyToolBundles(base, null), base);
  assert.equal(mergeCattyToolBundles(base, { tools: {}, toolsContext: {} }), base);

  const extra = buildExternalMcpTools([descriptor()], makeContext());
  const merged = mergeCattyToolBundles(base, extra);
  assert.ok(merged.tools.terminal_execute);
  assert.ok(merged.tools['mcp__files__read']);
  assert.equal(merged.policies?.['mcp__files__read']?.write, true);
  // No fixed capability id: approval grants must stay scoped per tool name.
  assert.equal(merged.policies?.['mcp__files__read']?.capabilityId, undefined);
});

test('summarizeExternalMcpServers groups descriptors by server', () => {
  const summary = summarizeExternalMcpServers([
    descriptor(),
    descriptor({ toolName: 'write' }),
    descriptor({ serverId: 's2', serverName: 'Remote', autoApprove: true }),
  ]);
  assert.deepEqual(summary, [
    { name: 'Files', toolCount: 2, autoApprove: false },
    { name: 'Remote', toolCount: 1, autoApprove: true },
  ]);
});
