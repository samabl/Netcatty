"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const ptyExec = require("../ai/ptyExec.cjs");
const { registerCattyExecHandlers } = require("./cattyExecHandlers.cjs");

class FakeSerialPort extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
  }

  write(data) {
    this.writes.push(String(data));
  }
}

function createFakeIpcMain() {
  return {
    handlers: new Map(),
    handle(channel, handler) {
      this.handlers.set(channel, handler);
    },
  };
}

function registerSerialExecHandler(session) {
  const ipcMain = createFakeIpcMain();
  const releases = [];
  const mcpServerBridge = {
    getPermissionMode: () => "auto",
    getSessionBusyError: () => null,
    reserveSessionExecution() {
      return { ok: true, token: "token-1" };
    },
    releaseSessionExecution(_sessionId, token) {
      releases.push(token);
    },
    getSessionMeta() {
      return { protocol: "serial", deviceType: "network" };
    },
    getCommandTimeoutMs() {
      return 60;
    },
    getCommandBlocklist() {
      return [];
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
    activePtyExecs: new Map(),
  };

  registerCattyExecHandlers({
    ipcMain,
    validateSender: () => true,
    sessions: new Map([["serial-1", session]]),
    terminalWorkerManager: null,
    mcpServerBridge,
    electronModule: {},
    safeSend() {},
    execViaPty() {
      throw new Error("serial sessions must never be shell-wrapped");
    },
    getFreshIdlePrompt() {
      return "";
    },
    // Production resolves this through the aiBridge handler context
    // (electron/bridges base), so point the handler at the real module here.
    require(spec) {
      if (spec === "./ai/ptyExec.cjs") return ptyExec;
      return require(spec);
    },
  });

  return { ipcMain, releases };
}

test("catty terminal_execute sends serial commands through the raw serial port", async () => {
  // Regression: serial sessions are flagged as network devices but expose no PTY,
  // so the network-device guard used to reject them before the serial branch ran.
  const serialPort = new FakeSerialPort();
  const { ipcMain, releases } = registerSerialExecHandler({
    protocol: "serial",
    type: "serial",
    shellKind: "raw",
    serialPort,
    serialEncoding: "gb18030",
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "serial-1", command: "show version", chatSessionId: "chat-serial" },
  );

  assert.deepEqual(serialPort.writes, ["show version\r"]);
  assert.notEqual(
    result.error,
    "Network device session has no writable PTY stream for command execution",
  );
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, null);
  assert.match(result.stdout, /no output received/);
  assert.deepEqual(releases, ["token-1"], "serial exec must release the session lock");
});

test("catty serial exec refuses to write while a serial file transfer is active", async () => {
  const serialPort = new FakeSerialPort();
  const { ipcMain, releases } = registerSerialExecHandler({
    protocol: "serial",
    type: "serial",
    shellKind: "raw",
    serialPort,
    zmodemSentry: { isActive: () => true },
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "serial-1", command: "show version", chatSessionId: "chat-serial" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "Serial file transfer is already in progress");
  assert.deepEqual(serialPort.writes, []);
  assert.deepEqual(releases, ["token-1"]);
});

test("catty serial exec reports a missing serial port instead of the network-device PTY error", async () => {
  const { ipcMain, releases } = registerSerialExecHandler({
    protocol: "serial",
    type: "serial",
    shellKind: "raw",
  });

  const result = await ipcMain.handlers.get("netcatty:ai:exec")(
    { sender: { id: 7 } },
    { sessionId: "serial-1", command: "show version", chatSessionId: "chat-serial" },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error, "Serial session has no writable port for command execution");
  assert.deepEqual(releases, ["token-1"]);
});
