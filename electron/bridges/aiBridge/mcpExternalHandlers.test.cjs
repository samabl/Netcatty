"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { registerExternalMcpClientHandlers } = require("./mcpExternalHandlers.cjs");

function createHarness(options = {}) {
  const { authorized = true, manager = true } = options;
  const handlers = new Map();
  const calls = { setServers: [], callTool: [] };
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };
  const mcpClientManager = manager
    ? {
      setServers: async (servers) => calls.setServers.push(servers),
      getStatus: () => [{ id: "s1", state: "connected" }],
      listTools: () => [{ serverId: "s1", toolName: "read" }],
      callTool: async (serverId, toolName, args, callOptions) => {
        calls.callTool.push({ serverId, toolName, args, callOptions });
        return { ok: true, result: "done" };
      },
    }
    : null;

  registerExternalMcpClientHandlers({
    ipcMain,
    validateSender: () => authorized,
    validateSenderOrSettings: () => authorized,
    mcpClientManager,
  });

  return { handlers, calls };
}

const event = {};

test("rejects unauthorized senders", async () => {
  const { handlers } = createHarness({ authorized: false });
  assert.deepEqual(await handlers.get("netcatty:ai:mcp-client:set-servers")(event, { servers: [] }), {
    ok: false,
    error: "Unauthorized IPC sender",
  });
  assert.deepEqual(await handlers.get("netcatty:ai:mcp-client:list-tools")(event), {
    ok: false,
    error: "Unauthorized IPC sender",
  });
});

test("set-servers forwards the list and returns status", async () => {
  const { handlers, calls } = createHarness();
  const servers = [{ id: "s1", name: "Files", transport: "stdio", command: "npx" }];
  const result = await handlers.get("netcatty:ai:mcp-client:set-servers")(event, { servers });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.setServers, [servers]);
  assert.deepEqual(result.status, [{ id: "s1", state: "connected" }]);
});

test("status and list-tools expose the manager snapshot", async () => {
  const { handlers } = createHarness();
  assert.deepEqual(await handlers.get("netcatty:ai:mcp-client:status")(event), {
    ok: true,
    status: [{ id: "s1", state: "connected" }],
  });
  assert.deepEqual(await handlers.get("netcatty:ai:mcp-client:list-tools")(event), {
    ok: true,
    tools: [{ serverId: "s1", toolName: "read" }],
  });
});

test("call-tool validates its parameters and forwards the timeout", async () => {
  const { handlers, calls } = createHarness();
  const callTool = handlers.get("netcatty:ai:mcp-client:call-tool");

  assert.deepEqual(await callTool(event, { toolName: "read" }), { error: "serverId is required." });
  assert.deepEqual(await callTool(event, { serverId: "s1" }), { error: "toolName is required." });

  assert.deepEqual(
    await callTool(event, { serverId: "s1", toolName: "read", args: { path: "/tmp" }, timeoutMs: 1234 }),
    { ok: true, result: "done" },
  );
  assert.deepEqual(calls.callTool, [{
    serverId: "s1",
    toolName: "read",
    args: { path: "/tmp" },
    callOptions: { timeoutMs: 1234 },
  }]);
});

test("missing manager degrades to an error instead of throwing", async () => {
  const { handlers } = createHarness({ manager: false });
  assert.deepEqual(await handlers.get("netcatty:ai:mcp-client:status")(event), {
    ok: false,
    error: "External MCP client is unavailable.",
  });
  assert.deepEqual(await handlers.get("netcatty:ai:mcp-client:call-tool")(event, { serverId: "s1", toolName: "read" }), {
    error: "External MCP client is unavailable.",
  });
});
