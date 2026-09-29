"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const TEST_TEMP_ROOT = path.join(__dirname, ".tmp-serial-session-log-tests");

class FakeSerialPort extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.writes = [];
    this.isOpen = false;
  }

  open(callback) {
    queueMicrotask(() => {
      this.isOpen = true;
      callback(null);
    });
  }

  write(data) {
    this.writes.push(String(data));
    return true;
  }

  close() {
    this.isOpen = false;
    // The real serialport binding emits "close" asynchronously. Reproduce that
    // so the exit handler races the synchronous sessions.delete() in
    // closeSession() exactly as it does for a real tab close.
    queueMicrotask(() => this.emit("close"));
  }
}

/**
 * terminalBridge.cjs loads `electron` (through sessionLogsBridge) and
 * `serialport` at module scope, so both are stubbed before the fresh require.
 */
function loadTerminalBridgeWithFakes() {
  const electronPath = require.resolve("electron");
  const serialPortPath = require.resolve("serialport");
  const bridgePath = require.resolve("./terminalBridge.cjs");
  const previousElectron = require.cache[electronPath];
  const previousSerialPort = require.cache[serialPortPath];
  const previousBridge = require.cache[bridgePath];

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: { webContents: { fromId: () => null } },
  };
  require.cache[serialPortPath] = {
    id: serialPortPath,
    filename: serialPortPath,
    loaded: true,
    exports: { SerialPort: FakeSerialPort },
  };
  delete require.cache[bridgePath];

  return {
    bridge: require("./terminalBridge.cjs"),
    restore() {
      delete require.cache[bridgePath];
      if (previousBridge) require.cache[bridgePath] = previousBridge;
      if (previousElectron) require.cache[electronPath] = previousElectron;
      else delete require.cache[electronPath];
      if (previousSerialPort) require.cache[serialPortPath] = previousSerialPort;
      else delete require.cache[serialPortPath];
    },
  };
}

function nextTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await nextTick();
  }
  return predicate();
}

test("closing a serial tab finalizes its auto-save log stream", async () => {
  const { bridge, restore } = loadTerminalBridgeWithFakes();
  const sessionLogStreamManager = require("./sessionLogStreamManager.cjs");
  const directory = path.join(
    TEST_TEMP_ROOT,
    `serial-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const sessionId = "serial-log-close";
  const stopCalls = [];
  const finalizedPaths = [];
  const originalStop = sessionLogStreamManager.stopStream;
  sessionLogStreamManager.stopStream = function stopStreamSpy(id, token) {
    stopCalls.push({ id, token });
    return Promise.resolve(originalStop.call(sessionLogStreamManager, id, token))
      .then((filePath) => {
        finalizedPaths.push(filePath);
        return filePath;
      });
  };
  const sessions = new Map();
  bridge.init({ sessions, electronModule: { webContents: { fromId: () => null } } });

  try {
    const started = await bridge.startSerialSession({ sender: { id: 7 } }, {
      sessionId,
      path: "/dev/ttyNETCATTYTEST",
      baudRate: 115200,
      charset: "utf-8",
      sessionLog: { enabled: true, directory, format: "txt" },
    });

    assert.deepEqual(started, { sessionId });
    const session = sessions.get(sessionId);
    assert.equal(session?.type, "serial");
    assert.ok(session?.logStreamToken, "auto-save log stream should be running");
    assert.equal(sessionLogStreamManager.hasStream(sessionId), true);
    sessionLogStreamManager.appendData(sessionId, "show version\r\nCisco IOS Software\r\n");

    bridge.closeSession({}, { sessionId });
    // Let the asynchronous port "close" event land, as it does after a real
    // tab close.
    await nextTick();
    await nextTick();

    assert.equal(sessions.has(sessionId), false);
    assert.equal(
      sessionLogStreamManager.hasStream(sessionId),
      false,
      "closing a serial tab must finalize the auto-save log stream",
    );
    assert.ok(
      stopCalls.some((call) => call.id === sessionId && call.token === session.logStreamToken),
      "the session's own stream token must be used so a reconnect stream is untouched",
    );
    assert.ok(
      await waitUntil(() => finalizedPaths.length > 0),
      "stopStream must return the finalized file path",
    );
    assert.match(fs.readFileSync(finalizedPaths.at(-1), "utf8"), /Cisco IOS Software/);
  } finally {
    sessionLogStreamManager.stopStream = originalStop;
    await sessionLogStreamManager.stopStream(sessionId);
    bridge.cleanupAllSessions();
    fs.rmSync(directory, { recursive: true, force: true });
    // Drop the shared root when nothing else is using it (fails harmlessly
    // while a parallel run still has directories in it).
    try { fs.rmdirSync(TEST_TEMP_ROOT); } catch { /* not empty */ }
    restore();
  }
});
