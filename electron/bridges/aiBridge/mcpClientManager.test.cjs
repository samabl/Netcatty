"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createMcpClientManager } = require("./mcpClientManager.cjs");

const silentLogger = { warn() {}, error() {}, log() {} };

function createFakeSdk(overrides = {}) {
  const state = { clients: [], transports: [], connectCalls: 0, listToolCalls: 0, closeCalls: 0, callToolCalls: [] };

  class FakeTransport {
    constructor(kind, target, options) {
      this.kind = kind;
      this.target = target;
      this.options = options;
      state.transports.push(this);
    }
  }

  class FakeClient {
    constructor(info, options) {
      this.info = info;
      this.options = options;
      this.closed = false;
      this.transport = null;
      state.clients.push(this);
    }
    async connect(transport) {
      state.connectCalls += 1;
      if (overrides.onConnect) await overrides.onConnect(transport, state);
      this.transport = transport;
    }
    async listTools() {
      state.listToolCalls += 1;
      if (overrides.listTools) return overrides.listTools(this.transport, state);
      return {
        tools: [{
          name: "read",
          description: "Read a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path", "ghost"],
          },
        }],
      };
    }
    async callTool(params) {
      state.callToolCalls.push(params);
      if (overrides.callTool) return overrides.callTool(params, state);
      return { content: [{ type: "text", text: "ok" }] };
    }
    async close() {
      this.closed = true;
      state.closeCalls += 1;
    }
  }

  return {
    sdk: {
      Client: FakeClient,
      StdioClientTransport: class extends FakeTransport {
        constructor(options) { super("stdio", options.command, options); }
      },
      StreamableHTTPClientTransport: class extends FakeTransport {
        constructor(url, options) { super("streamable-http", url, options); }
      },
      SSEClientTransport: class extends FakeTransport {
        constructor(url, options) { super("sse", url, options); }
      },
      getDefaultEnvironment: () => ({ PATH: "/usr/bin" }),
      version: "test",
    },
    state,
  };
}

function stdioServer(overrides = {}) {
  return {
    id: "s1",
    name: "Files",
    transport: "stdio",
    command: "npx",
    args: ["-y", "files"],
    enabled: true,
    ...overrides,
  };
}

test("setServers connects a stdio server, normalizes schemas and reports status", async () => {
  const { sdk, state } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer()]);

  const tools = manager.listTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].serverId, "s1");
  assert.equal(tools[0].serverName, "Files");
  assert.equal(tools[0].toolName, "read");
  assert.deepEqual(tools[0].inputSchema.required, ["path"]);
  assert.equal(tools[0].inputSchema.additionalProperties, true);

  const status = manager.getStatus();
  assert.equal(status.length, 1);
  assert.equal(status[0].state, "connected");
  assert.equal(status[0].toolCount, 1);
  assert.equal(status[0].error, null);

  // stdio inherits the SDK default environment and layers user env on top.
  assert.equal(state.transports[0].options.env.PATH, "/usr/bin");
  assert.equal(state.transports[0].options.cwd, undefined);

  await manager.dispose();
});

test("secret values are decrypted for the transport and never surface in status", async () => {
  const { sdk, state } = createFakeSdk();
  const seen = [];
  const manager = createMcpClientManager({
    loadSdk: () => sdk,
    logger: silentLogger,
    decryptSecret: (value) => {
      seen.push(value);
      return value.replace("enc:v1:", "");
    },
  });

  await manager.setServers([stdioServer({ env: [{ name: "TOKEN", value: "enc:v1:plain" }] })]);

  assert.deepEqual(seen, ["enc:v1:plain"]);
  assert.equal(state.transports[0].options.env.TOKEN, "plain");
  assert.equal(JSON.stringify(manager.getStatus()).includes("plain"), false);

  await manager.dispose();
});

test("disabled servers are tracked but never connected", async () => {
  const { sdk, state } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer({ enabled: false })]);

  assert.equal(state.connectCalls, 0);
  assert.equal(manager.listTools().length, 0);
  assert.equal(manager.getStatus()[0].state, "disabled");

  await manager.dispose();
});

test("removing a server disconnects it and drops its tools", async () => {
  const { sdk } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer()]);
  assert.equal(manager.listTools().length, 1);

  await manager.setServers([]);
  assert.equal(manager.listTools().length, 0);
  assert.deepEqual(manager.getStatus(), []);

  await manager.dispose();
});

test("renaming a server keeps the live connection; changing its command reconnects", async () => {
  const { sdk, state } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer()]);
  assert.equal(state.connectCalls, 1);

  await manager.setServers([stdioServer({ name: "Renamed" })]);
  assert.equal(state.connectCalls, 1);
  assert.equal(manager.listTools()[0].serverName, "Renamed");

  await manager.setServers([stdioServer({ name: "Renamed", command: "bunx" })]);
  assert.equal(state.connectCalls, 2);

  await manager.dispose();
});

test("toolAllowlist filters exposed tools", async () => {
  const { sdk } = createFakeSdk({
    listTools: () => ({ tools: [{ name: "read" }, { name: "write" }] }),
  });
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer({ toolAllowlist: ["write"] })]);
  assert.deepEqual(manager.listTools().map((tool) => tool.toolName), ["write"]);

  await manager.dispose();
});

test("callTool returns normalized text and blocks unexposed tools", async () => {
  const { sdk } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });
  await manager.setServers([stdioServer()]);

  assert.deepEqual(await manager.callTool("s1", "read", { path: "/tmp" }), { ok: true, result: "ok" });
  assert.deepEqual(
    (await manager.callTool("missing", "read", {})).error,
    'External MCP server "missing" is not configured.',
  );
  assert.match((await manager.callTool("s1", "nope", {})).error, /does not expose tool/);

  await manager.dispose();
});

test("callTool reports MCP tool errors as an error object", async () => {
  const { sdk } = createFakeSdk({
    callTool: () => ({ isError: true, content: [{ type: "text", text: "boom" }] }),
  });
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });
  await manager.setServers([stdioServer()]);

  assert.deepEqual(await manager.callTool("s1", "read", {}), { error: "boom" });
  await manager.dispose();
});

test("structuredContent is preserved on success", async () => {
  const { sdk } = createFakeSdk({
    callTool: () => ({
      content: [{ type: "text", text: "summary" }],
      structuredContent: { count: 3 },
    }),
  });
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });
  await manager.setServers([stdioServer()]);

  assert.deepEqual(await manager.callTool("s1", "read", {}), {
    ok: true,
    result: "summary",
    structuredContent: { count: 3 },
  });
  await manager.dispose();
});

test("streamable HTTP falls back to SSE when the first transport fails", async () => {
  const { sdk, state } = createFakeSdk({
    onConnect: (transport) => {
      if (transport.kind === "streamable-http") throw new Error("405 method not allowed");
    },
  });
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([{
    id: "remote",
    name: "Remote",
    transport: "http",
    url: "https://mcp.example/rpc",
    headers: [{ name: "Authorization", value: "Bearer t" }],
    enabled: true,
  }]);

  assert.equal(manager.getStatus()[0].state, "connected");
  const sse = state.transports.find((transport) => transport.kind === "sse");
  assert.deepEqual(sse.options.requestInit.headers, { Authorization: "Bearer t" });

  await manager.dispose();
});

test("connection failures surface a bounded error and stay retryable", async () => {
  let attempt = 0;
  const { sdk } = createFakeSdk({
    onConnect: () => {
      attempt += 1;
      if (attempt === 1) throw new Error("  spawn   ENOENT  ");
    },
  });
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer()]);
  assert.equal(manager.getStatus()[0].state, "error");
  assert.equal(manager.getStatus()[0].error, "spawn ENOENT");

  // A repeat sync retries errored servers instead of giving up forever.
  await manager.setServers([stdioServer()]);
  assert.equal(manager.getStatus()[0].state, "connected");
  assert.equal(manager.getStatus()[0].error, null);

  await manager.dispose();
});

test("auto-approve is exposed without forcing a reconnect", async () => {
  const { sdk, state } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await manager.setServers([stdioServer()]);
  assert.equal(state.connectCalls, 1);
  assert.equal(manager.listTools()[0].autoApprove, false);

  await manager.setServers([stdioServer({ autoApprove: true })]);
  assert.equal(state.connectCalls, 1);
  assert.equal(manager.listTools()[0].autoApprove, true);

  await manager.dispose();
});

test("a missing MCP SDK marks servers errored without throwing", async () => {
  const manager = createMcpClientManager({
    loadSdk: () => { throw new Error("sdk unavailable"); },
    logger: silentLogger,
  });

  await manager.setServers([stdioServer()]);
  assert.equal(manager.getStatus()[0].state, "error");
  assert.equal(manager.getStatus()[0].error, "sdk unavailable");

  await manager.dispose();
});

test("concurrent setServers calls are serialized", async () => {
  const { sdk, state } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });

  await Promise.all([
    manager.setServers([stdioServer()]),
    manager.setServers([stdioServer({ command: "bunx" })]),
  ]);

  assert.equal(manager.getStatus().length, 1);
  assert.equal(manager.getStatus()[0].state, "connected");
  assert.equal(state.connectCalls, 2);

  await manager.dispose();
});

test("dispose closes every client", async () => {
  const { sdk, state } = createFakeSdk();
  const manager = createMcpClientManager({ loadSdk: () => sdk, logger: silentLogger });
  await manager.setServers([stdioServer()]);

  await manager.dispose();
  assert.equal(state.closeCalls, 1);
  assert.equal(manager.listTools().length, 0);
});

test("normalizeConfig rejects unusable entries", () => {
  const manager = createMcpClientManager({ logger: silentLogger });
  assert.equal(manager._normalizeConfig({ id: "x", transport: "stdio" }), null);
  assert.equal(manager._normalizeConfig({ id: "x", transport: "http", url: "ftp://x" }), null);
  assert.equal(manager._normalizeConfig({ transport: "stdio", command: "x" }), null);
  assert.equal(manager._normalizeConfig({ id: "x", transport: "http", url: "https://x/y" }).transport, "http");
});

test("fingerprint ignores the display name but tracks credentials", () => {
  const manager = createMcpClientManager({ logger: silentLogger });
  const base = manager._normalizeConfig(stdioServer());
  const renamed = manager._normalizeConfig(stdioServer({ name: "Other" }));
  const recredentialed = manager._normalizeConfig(stdioServer({ env: [{ name: "A", value: "b" }] }));

  assert.equal(manager._fingerprintOf(base), manager._fingerprintOf(renamed));
  assert.notEqual(manager._fingerprintOf(base), manager._fingerprintOf(recredentialed));
});
