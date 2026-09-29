const assert = require("node:assert/strict");
const test = require("node:test");

const { registerCattyExecHandlers } = require("./cattyExecHandlers.cjs");

function createFakeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
  };
}

function createWorkerExecHarness({ meta, commonSafety = { blocked: false }, shellSafety = { blocked: false } }) {
  const ipcMain = createFakeIpcMain();
  const requests = [];
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ ok: true, stdout: "ok\n" });
    },
  };
  const mcpServerBridge = {
    getPermissionMode: () => "auto",
    getSessionBusyError: () => null,
    reserveSessionExecution: () => ({ ok: true, token: "token-1" }),
    releaseSessionExecution() {},
    getSessionMeta: () => meta,
    checkCommandSafetyForShell: () => shellSafety,
    checkCommandSafetyCommonOnly: () => commonSafety,
    resolveSessionBlocklistShellKind: () => "",
    getCommandTimeoutMs: () => 12345,
    getCommandBlocklist: () => [],
    activePtyExecs: new Map(),
  };

  registerCattyExecHandlers({
    ipcMain,
    validateSender: () => true,
    sessions: new Map(),
    terminalWorkerManager,
    mcpServerBridge,
    electronModule: {},
    safeSend() {},
    execViaPty() {
      throw new Error("main process should not execute without a real session");
    },
    getFreshIdlePrompt() {
      return "";
    },
  });

  return { ipcMain, requests };
}

test("catty AI exec defers the shell blocklist when renderer metadata has no protocol", async () => {
  // Renderer metadata can lag a freshly opened tab. With no protocol a serial
  // device session is indistinguishable from a shell session here, so applying
  // the common patterns would block routine device commands (`reboot`) that the
  // worker-owned live session would allow.
  const { ipcMain, requests } = createWorkerExecHarness({
    meta: { hostname: "/dev/ttyUSB0" },
    commonSafety: { blocked: true, matchedPattern: "\\b(shutdown|reboot|poweroff|halt)\\b" },
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "serial-1", command: "reboot", chatSessionId: "chat-1" },
  );

  assert.deepEqual(result, { ok: true, stdout: "ok\n" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].channel, "netcatty:ai:exec");
});

test("catty AI exec still applies the shell blocklist when the protocol is known", async () => {
  const blockedHarness = createWorkerExecHarness({
    meta: { protocol: "ssh", deviceType: "", hostname: "host.example" },
    commonSafety: { blocked: true, matchedPattern: "\\b(shutdown|reboot|poweroff|halt)\\b" },
  });

  const blocked = await blockedHarness.ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "ssh-1", command: "reboot", chatSessionId: "chat-1" },
  );

  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Command blocked by safety policy/);
  assert.deepEqual(blockedHarness.requests, [], "a blocked command must not reach the terminal worker");
});

test("catty AI exec proxies to the terminal worker when the real session lives in the worker", async () => {
  const ipcMain = createFakeIpcMain();
  const requests = [];
  const terminalWorkerManager = {
    request(channel, payload, options) {
      requests.push({ channel, payload, options });
      return Promise.resolve({ ok: true, stdout: "ok\n" });
    },
  };
  const locks = [];
  const mcpServerBridge = {
    getPermissionMode: () => "auto",
    getSessionBusyError: () => null,
    reserveSessionExecution(sessionId, kind) {
      locks.push(["reserve", sessionId, kind]);
      return { ok: true, token: "token-1" };
    },
    releaseSessionExecution(sessionId, token) {
      locks.push(["release", sessionId, token]);
    },
    getSessionMeta() {
      return { protocol: "ssh", deviceType: "", hostname: "host.example" };
    },
    checkCommandSafetyForShell() {
      return { blocked: false };
    },
    checkCommandSafetyCommonOnly() {
      return { blocked: false };
    },
    resolveSessionBlocklistShellKind() {
      return "";
    },
    getCommandTimeoutMs() {
      return 12345;
    },
    getCommandBlocklist() {
      return [];
    },
    activePtyExecs: new Map(),
  };

  registerCattyExecHandlers({
    ipcMain,
    validateSender: () => true,
    sessions: new Map(),
    terminalWorkerManager,
    mcpServerBridge,
    electronModule: {},
    safeSend() {},
    execViaPty() {
      throw new Error("main process should not execute without a real session");
    },
    getFreshIdlePrompt() {
      return "";
    },
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "ssh-1", command: "pwd", chatSessionId: "chat-1" },
  );

  assert.deepEqual(result, { ok: true, stdout: "ok\n" });
  assert.deepEqual(requests, [
    {
      channel: "netcatty:ai:exec",
      payload: {
        sessionId: "ssh-1",
        command: "pwd",
        chatSessionId: "chat-1",
        commandTimeoutMs: 12345,
        sessionMeta: { protocol: "ssh", deviceType: "", hostname: "host.example" },
        commandBlocklist: [],
      },
      options: { webContentsId: 7 },
    },
  ]);
  assert.deepEqual(locks, [
    ["reserve", "ssh-1", "exec"],
    ["release", "ssh-1", "token-1"],
  ]);
});
