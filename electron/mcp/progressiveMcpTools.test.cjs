"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { ToolListChangedNotificationSchema } = require("@modelcontextprotocol/sdk/types.js");

const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");
const {
  CORE_MCP_TOOL_NAMES,
  DEFERRED_MCP_TOOLSETS,
  MCP_TOOL_CALLER_NAME,
  MCP_TOOL_LOADER_NAME,
  buildProgressiveMcpCatalog,
  buildToolInputJsonSchema,
  registerProgressiveMcpTools,
} = require("./progressiveMcpTools.cjs");

// Two transport-control tools (loader + caller) sit on top of the core surface.
const TRANSPORT_TOOL_NAMES = [MCP_TOOL_LOADER_NAME, MCP_TOOL_CALLER_NAME];
const INITIAL_TOOL_COUNT = CORE_MCP_TOOL_NAMES.length + TRANSPORT_TOOL_NAMES.length;

function createFakeServer() {
  const registrations = [];
  const handlers = new Map();
  return {
    registrations,
    handlers,
    tool(name, _description, schemaOrHandler, maybeHandler) {
      if (handlers.has(name)) throw new Error(`Tool ${name} is already registered`);
      const handler = typeof schemaOrHandler === "function" ? schemaOrHandler : maybeHandler;
      registrations.push(name);
      handlers.set(name, handler);
      return { enabled: true };
    },
  };
}

function createDeps(rpcCall = async () => ({ ok: true })) {
  return {
    rpcCall,
    scopeParams: {},
    guardWriteOperation: () => null,
    catalogDescription: (_name, fallback) => fallback,
  };
}

function findCatalogTool(name) {
  return listMcpTools().find(tool => tool.mcpTool === name);
}

function readTextResult(result) {
  return JSON.parse(result.content[0].text);
}

test("progressive MCP catalog assigns every non-core catalog tool exactly once", () => {
  const allNames = listMcpTools().map(tool => tool.mcpTool);
  const deferredNames = Object.values(DEFERRED_MCP_TOOLSETS).flat();

  assert.deepEqual(CORE_MCP_TOOL_NAMES, [
    "get_environment",
    "session_close",
    "terminal_execute",
    "terminal_start",
    "terminal_poll",
    "terminal_stop",
    "sftp_list",
    "sftp_read_file",
    "sftp_write_file",
    "sftp_download",
    "sftp_upload",
    "vault_hosts_list",
    "host_open",
    "terminal_read_context",
  ]);
  assert.equal(new Set(deferredNames).size, deferredNames.length);
  assert.deepEqual(
    new Set([...CORE_MCP_TOOL_NAMES, ...deferredNames]),
    new Set(allNames),
  );
  assert.doesNotThrow(() => buildProgressiveMcpCatalog());
});

test("progressive MCP registration initially exposes the core tools plus both transport tools", () => {
  const server = createFakeServer();
  const result = registerProgressiveMcpTools(server, createDeps());

  assert.equal(result.initialToolCount, INITIAL_TOOL_COUNT);
  assert.equal(server.registrations.length, INITIAL_TOOL_COUNT);
  assert.deepEqual(
    new Set(server.registrations),
    new Set([...TRANSPORT_TOOL_NAMES, ...CORE_MCP_TOOL_NAMES]),
  );
});

test("loading a deferred MCP toolset is selective, idempotent, and returns schemas", async () => {
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps());
  const loadTools = server.handlers.get(MCP_TOOL_LOADER_NAME);

  const first = readTextResult(await loadTools({ toolset: "attachments" }));
  assert.deepEqual(first.newlyLoaded, DEFERRED_MCP_TOOLSETS.attachments);
  assert.deepEqual(first.alreadyLoaded, []);
  assert.equal(server.registrations.length, INITIAL_TOOL_COUNT + 2);
  assert.equal(server.handlers.has("scripts_list"), false);
  assert.deepEqual(
    first.tools.map(tool => tool.name),
    DEFERRED_MCP_TOOLSETS.attachments,
  );
  assert.equal(first.visibleToolCount, INITIAL_TOOL_COUNT + 2);
  assert.match(first.hint, /call_netcatty_tool/);
  const readAttachment = first.tools.find(tool => tool.name === "read_attachment");
  assert.equal(readAttachment.inputSchema.properties.filePath.type, "string");
  assert.equal(readAttachment.inputSchema.required, undefined);

  const second = readTextResult(await loadTools({ toolset: "attachments" }));
  assert.deepEqual(second.newlyLoaded, []);
  assert.deepEqual(second.alreadyLoaded, DEFERRED_MCP_TOOLSETS.attachments);
  assert.equal(server.registrations.length, INITIAL_TOOL_COUNT + 2);
});

test("loading all makes every catalog MCP tool available", async () => {
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps());
  const loadTools = server.handlers.get(MCP_TOOL_LOADER_NAME);

  await loadTools({ toolset: "vault_notes" });
  const result = readTextResult(await loadTools({ toolset: "all" }));
  const catalogNames = listMcpTools().map(tool => tool.mcpTool);

  assert.deepEqual(result.alreadyLoaded, DEFERRED_MCP_TOOLSETS.vault_notes);
  assert.equal(result.loadedCatalogToolCount, catalogNames.length);
  assert.equal(result.visibleToolCount, catalogNames.length + TRANSPORT_TOOL_NAMES.length);
  assert.equal(result.remainingCatalogToolCount, 0);
  assert.deepEqual(
    new Set(server.registrations),
    new Set([...TRANSPORT_TOOL_NAMES, ...catalogNames]),
  );
});

test("buildToolInputJsonSchema mirrors required, optional, and numeric catalog fields", () => {
  assert.deepEqual(buildToolInputJsonSchema({
    sessionId: { type: "string", description: "Session ID." },
    offset: { type: "number", optional: true },
  }), {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID." },
      offset: { type: "integer" },
    },
    required: ["sessionId"],
  });
  assert.deepEqual(buildToolInputJsonSchema(undefined), { type: "object", properties: {} });
});

test("call_netcatty_tool runs a deferred catalog tool and registers it", async () => {
  const calls = [];
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps(async (method, params) => {
    calls.push({ method, params });
    return { ok: true, scripts: [{ id: "script-1" }] };
  }));
  const callTool = server.handlers.get(MCP_TOOL_CALLER_NAME);

  assert.equal(server.handlers.has("scripts_list"), false);

  const result = await callTool({ tool: "scripts_list", arguments: { folderId: "folder-1" } });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, [{ method: findCatalogTool("scripts_list").rpcMethod, params: { folderId: "folder-1" } }]);
  assert.match(result.content[0].text, /script-1/);
  // The proxied call leaves the same footprint as a direct call.
  assert.equal(server.handlers.has("scripts_list"), true);

  const loadTools = server.handlers.get(MCP_TOOL_LOADER_NAME);
  const reloaded = readTextResult(await loadTools({ toolset: "scripts" }));
  assert.ok(reloaded.alreadyLoaded.includes("scripts_list"));
  assert.ok(reloaded.newlyLoaded.includes("scripts_run"));
});

test("call_netcatty_tool rejects arguments that miss the catalog input shape", async () => {
  const calls = [];
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps(async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  }));
  const callTool = server.handlers.get(MCP_TOOL_CALLER_NAME);

  const missing = await callTool({ tool: "scripts_get", arguments: {} });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /invalid arguments for scripts_get/);
  assert.match(missing.content[0].text, /missing required scriptId/);

  const wrongType = await callTool({ tool: "scripts_get", arguments: { scriptId: 7 } });
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.content[0].text, /wrong type for scriptId/);

  // Rejected calls never reach the bridge and never register the tool.
  assert.deepEqual(calls, []);
  assert.equal(server.handlers.has("scripts_get"), false);

  await callTool({ tool: "scripts_get", arguments: { scriptId: "script-1" } });
  assert.deepEqual(calls, [{ method: findCatalogTool("scripts_get").rpcMethod, params: { scriptId: "script-1" } }]);
});

test("call_netcatty_tool defaults missing arguments and rejects unknown tools", async () => {
  const calls = [];
  const server = createFakeServer();
  registerProgressiveMcpTools(server, createDeps(async (method, params) => {
    calls.push({ method, params });
    return { ok: true };
  }));
  const callTool = server.handlers.get(MCP_TOOL_CALLER_NAME);

  await callTool({ tool: " get_environment " });
  assert.deepEqual(calls, [{ method: findCatalogTool("get_environment").rpcMethod, params: {} }]);

  const unknown = await callTool({ tool: "scripts_frobnicate", arguments: {} });
  assert.equal(unknown.isError, true);
  assert.match(unknown.content[0].text, /Unknown Netcatty tool "scripts_frobnicate"/);
  assert.match(unknown.content[0].text, /load_netcatty_tools/);

  const missing = await callTool({ tool: "" });
  assert.equal(missing.isError, true);
});

test("MCP clients that ignore tools/list_changed can still call deferred tools", async () => {
  const calls = [];
  const server = new McpServer({ name: "progressive-test", version: "1.0.0" });
  registerProgressiveMcpTools(server, createDeps(async (method, params) => {
    calls.push({ method, params });
    return { ok: true, scripts: [{ id: "script-42" }] };
  }));

  const client = new Client({ name: "stale-client", version: "1.0.0" });
  // Models Codex / Cursor CLI: the notification arrives, the client never
  // re-fetches `tools/list`, so the tool is uncallable from its own registry.
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {});

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const initial = await client.listTools();
    assert.equal(initial.tools.length, INITIAL_TOOL_COUNT);
    assert.equal(initial.tools.some(tool => tool.name === MCP_TOOL_CALLER_NAME), true);
    assert.equal(initial.tools.some(tool => tool.name === "scripts_list"), false);

    const result = await client.callTool({
      name: MCP_TOOL_CALLER_NAME,
      arguments: { tool: "scripts_list", arguments: {} },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ method: findCatalogTool("scripts_list").rpcMethod, params: {} }]);
    assert.match(result.content[0].text, /script-42/);

    const refreshed = await client.listTools();
    assert.equal(refreshed.tools.some(tool => tool.name === "scripts_list"), true);
  } finally {
    await client.close();
  }
});

test("MCP clients receive the updated tool list without reconnecting", async () => {
  const server = new McpServer({ name: "progressive-test", version: "1.0.0" });
  registerProgressiveMcpTools(server, createDeps());

  const client = new Client({ name: "progressive-test-client", version: "1.0.0" });
  let listChangedNotifications = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChangedNotifications += 1;
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const initial = await client.listTools();
    assert.equal(initial.tools.length, INITIAL_TOOL_COUNT);
    assert.equal(initial.tools.some(tool => tool.name === "list_attachments"), false);

    await client.callTool({
      name: MCP_TOOL_LOADER_NAME,
      arguments: { toolset: "attachments" },
    });

    const updated = await client.listTools();
    assert.ok(listChangedNotifications >= 1);
    assert.equal(updated.tools.length, INITIAL_TOOL_COUNT + 2);
    assert.equal(updated.tools.some(tool => tool.name === "list_attachments"), true);
    assert.equal(updated.tools.some(tool => tool.name === "read_attachment"), true);
  } finally {
    await client.close();
  }
});
