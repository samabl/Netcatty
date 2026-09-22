import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXTERNAL_MCP_IMPORT_MAX_SERVERS,
  applyExternalMcpImport,
  parseExternalMcpServerImport,
  type ExternalMcpImportAction,
} from './externalMcpImport.ts';
import type { ExternalMcpServer } from './externalMcpServer.ts';

const NOW = 1_700_000_000_000;

function parse(text: string, existing?: ExternalMcpServer[]) {
  return parseExternalMcpServerImport(text, { now: NOW, existing });
}

function server(overrides: Partial<ExternalMcpServer> = {}): ExternalMcpServer {
  return {
    id: 's1',
    name: 'Files',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    createdAt: 1,
    ...overrides,
  };
}

test('reads a Claude Desktop "mcpServers" map and names servers from the key', () => {
  const result = parse(JSON.stringify({
    mcpServers: {
      files: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: { TOKEN: 'abc' },
      },
    },
  }));

  assert.equal(result.error, null);
  assert.deepEqual(result.skipped, []);
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, 'add');
  assert.equal(result.actions[0].targetId, undefined);
  const entry = result.actions[0].server;
  assert.equal(entry.name, 'files');
  assert.equal(entry.transport, 'stdio');
  assert.equal(entry.command, 'npx');
  assert.deepEqual(entry.args, ['-y', '@modelcontextprotocol/server-filesystem', '/tmp']);
  assert.deepEqual(entry.env, [{ name: 'TOKEN', value: 'abc' }]);
  assert.equal(entry.enabled, true);
  assert.equal(entry.createdAt, NOW);
  assert.match(entry.id, /^mcp-/);
});

test('reads a VS Code "servers" map, ignores $schema and inputs, and maps type', () => {
  const result = parse(JSON.stringify({
    $schema: 'https://example.com/mcp.schema.json',
    inputs: [{ id: 'token', type: 'promptString' }],
    servers: {
      remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer t' } },
      legacy: { type: 'sse', url: 'https://mcp.example.com/sse' },
    },
  }));

  assert.equal(result.error, null);
  const byName = new Map(result.actions.map((action) => [action.server.name, action.server]));
  assert.equal(byName.size, 2);
  assert.equal(byName.get('remote')?.transport, 'http');
  assert.equal(byName.get('remote')?.url, 'https://mcp.example.com/mcp');
  assert.deepEqual(byName.get('remote')?.headers, [{ name: 'Authorization', value: 'Bearer t' }]);
  assert.equal(byName.get('legacy')?.transport, 'sse');
});

test('reads nested mcp.servers, a bare name -> config map, and a single record', () => {
  const nested = parse(JSON.stringify({ mcp: { servers: { one: { command: 'a' } } } }));
  assert.equal(nested.actions[0]?.server.name, 'one');

  const bare = parse(JSON.stringify({ two: { command: 'b' }, three: { url: 'https://x/mcp' } }));
  assert.deepEqual(bare.actions.map((action) => action.server.name), ['two', 'three']);
  assert.equal(bare.actions[1].server.transport, 'http');

  const single = parse(JSON.stringify({ name: 'solo', command: 'c', args: ['--x'] }));
  assert.deepEqual(single.actions.map((action) => action.server.name), ['solo']);
  assert.deepEqual(single.skipped, []);
});

test('round-trips a Netcatty array export with fresh ids', () => {
  const result = parse(JSON.stringify([
    {
      id: 'mcp-existing',
      name: 'Docs',
      enabled: false,
      transport: 'stdio',
      command: 'docs-server',
      args: ['serve'],
      cwd: '/srv/docs',
      autoApprove: true,
      toolAllowlist: ['search'],
    },
  ]));

  assert.equal(result.error, null);
  const entry = result.actions[0].server;
  assert.equal(entry.id === 'mcp-existing', false);
  assert.match(entry.id, /^mcp-/);
  assert.equal(entry.name, 'Docs');
  assert.equal(entry.enabled, false);
  assert.equal(entry.command, 'docs-server');
  assert.deepEqual(entry.args, ['serve']);
  assert.equal(entry.cwd, '/srv/docs');
  assert.equal(entry.autoApprove, true);
  assert.deepEqual(entry.toolAllowlist, ['search']);
});

test('normalizes transport aliases, serverUrl, and the disabled flag', () => {
  const result = parse(JSON.stringify({
    a: { type: 'streamable-http', url: 'https://a/mcp' },
    b: { serverUrl: 'https://b/mcp' },
    c: { command: 'sleepy', disabled: true },
  }));

  const byName = new Map(result.actions.map((action) => [action.server.name, action.server]));
  assert.equal(byName.get('a')?.transport, 'http');
  assert.equal(byName.get('b')?.transport, 'http');
  assert.equal(byName.get('b')?.url, 'https://b/mcp');
  assert.equal(byName.get('c')?.enabled, false);
});

test('skips entries that cannot be runnable and reports why', () => {
  const result = parse(JSON.stringify({
    mcpServers: {
      ok: { command: 'good' },
      unnamedTransport: { args: ['--nope'] },
      badUrl: { type: 'http', url: 'ftp://example.com' },
    },
  }));

  assert.equal(result.error, null);
  assert.deepEqual(result.actions.map((action) => action.server.name), ['ok']);
  assert.deepEqual(result.skipped, [
    { name: 'unnamedTransport', reason: 'invalid-entry' },
    { name: 'badUrl', reason: 'invalid-entry' },
  ]);
});

test('updates a same-name server in place and keeps its identity', () => {
  const existing = server({
    id: 'mcp-existing',
    name: 'Files',
    enabled: false,
    createdAt: 5,
    command: 'old',
    args: ['old'],
    env: [{ name: 'OLD', value: '1' }],
  });

  const result = parse(
    JSON.stringify({ mcpServers: { files: { command: 'new', args: ['new'], env: { NEW: '2' } } } }),
    [existing],
  );

  assert.equal(result.actions.length, 1);
  const [action] = result.actions;
  assert.equal(action.kind, 'update');
  assert.equal(action.targetId, 'mcp-existing');
  assert.equal(action.server.id, 'mcp-existing');
  assert.equal(action.server.name, 'Files');
  assert.equal(action.server.enabled, false);
  assert.equal(action.server.createdAt, 5);
  assert.equal(action.server.updatedAt, NOW);
  assert.equal(action.server.command, 'new');
  assert.deepEqual(action.server.args, ['new']);
  assert.deepEqual(action.server.env, [{ name: 'NEW', value: '2' }]);
});

test('an update replaces the transport config and drops stale fields', () => {
  const existing = server({
    id: 'mcp-a',
    name: 'files',
    command: 'old',
    args: ['a'],
    env: [{ name: 'K', value: 'v' }],
  });

  const result = parse(
    JSON.stringify({ mcpServers: { files: { type: 'http', url: 'https://x/mcp', headers: { H: '1' } } } }),
    [existing],
  );

  const updated = result.actions[0].server;
  assert.equal(result.actions[0].kind, 'update');
  assert.equal(updated.transport, 'http');
  assert.equal(updated.url, 'https://x/mcp');
  assert.deepEqual(updated.headers, [{ name: 'H', value: '1' }]);
  assert.equal(updated.command, undefined);
  assert.equal(updated.args, undefined);
  assert.equal(updated.env, undefined);
});

test('a name repeated inside the document keeps the last definition once', () => {
  const result = parse(JSON.stringify([
    { name: 'same', command: 'first' },
    { name: 'SAME', command: 'second', args: ['x'] },
  ]));

  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].kind, 'add');
  assert.equal(result.actions[0].server.command, 'second');
  assert.deepEqual(result.actions[0].server.args, ['x']);
});

test('caps a single import at EXTERNAL_MCP_IMPORT_MAX_SERVERS', () => {
  const entries = Array.from(
    { length: EXTERNAL_MCP_IMPORT_MAX_SERVERS + 3 },
    (_unused, index) => ({ name: 's' + index, command: 'cmd' }),
  );
  const result = parse(JSON.stringify(entries));

  assert.equal(result.actions.length, EXTERNAL_MCP_IMPORT_MAX_SERVERS);
  assert.deepEqual(result.skipped, [
    { name: 's' + EXTERNAL_MCP_IMPORT_MAX_SERVERS, reason: 'limit-reached' },
    { name: 's' + (EXTERNAL_MCP_IMPORT_MAX_SERVERS + 1), reason: 'limit-reached' },
    { name: 's' + (EXTERNAL_MCP_IMPORT_MAX_SERVERS + 2), reason: 'limit-reached' },
  ]);
});

test('reports unparseable and unrecognizable documents', () => {
  assert.equal(parse('').error, 'invalid-json');
  assert.equal(parse('{ not json').error, 'invalid-json');
  assert.equal(parse('"just a string"').error, 'unsupported-shape');
  assert.equal(parse('42').error, 'unsupported-shape');
  assert.equal(parse('{ "mcpServers": {} }').error, 'unsupported-shape');
  assert.deepEqual(parse('null').actions, []);

  const invalid = parse('{ not json');
  assert.deepEqual(invalid.actions, []);
  assert.deepEqual(invalid.skipped, []);
});

test('keeps secret values verbatim for the caller to encrypt', () => {
  const result = parse(JSON.stringify({
    mcpServers: {
      secure: { url: 'https://x/mcp', headers: { 'X-Api-Key': 'sk-secret' } },
    },
  }));

  assert.deepEqual(result.actions[0]?.server.headers, [{ name: 'X-Api-Key', value: 'sk-secret' }]);
});

test('applyExternalMcpImport appends adds and replaces updates in place', () => {
  const a = server({ id: 'a', name: 'A' });
  const b = server({ id: 'b', name: 'B' });
  const added = server({ id: 'c', name: 'C' });
  const updatedB = server({ id: 'b', name: 'B', command: 'updated' });

  const actions: ExternalMcpImportAction[] = [
    { kind: 'update', targetId: 'b', server: updatedB },
    { kind: 'add', server: added },
  ];
  const merged = applyExternalMcpImport([a, b], actions);

  assert.deepEqual(merged.map((entry) => entry.id), ['a', 'b', 'c']);
  assert.equal(merged[1].command, 'updated');
  assert.equal(merged[0], a);

  const fallback = applyExternalMcpImport([a], [
    { kind: 'update', targetId: 'missing', server: server({ id: 'd', name: 'D' }) },
  ]);
  assert.deepEqual(fallback.map((entry) => entry.id), ['a', 'd']);
});
