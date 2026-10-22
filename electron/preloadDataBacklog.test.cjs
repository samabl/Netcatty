const assert = require("node:assert/strict");
const test = require("node:test");

const { createPreloadApi } = require("./preload/api.cjs");
const {
  clearTerminalDataBacklog,
  clearTerminalDataSession,
  createTerminalDataBacklog,
  createTerminalDataDispatcher,
} = require("./preload/terminalDataBacklog.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const createTerminalPerfMeta = (id = "perf-1") => ({
  id,
  emittedAt: 1234,
  sessionId: "session-1",
  chars: 5,
  lineFeeds: 0,
});

function createFakePort() {
  return {
    onmessage: null,
    close() {},
    emit(data) {
      this.onmessage?.({ data });
    },
  };
}

const { loadPreloadWithFakeElectron } = require("./preload/fixtures/loadPreloadWithFakeElectron.cjs");

test("setTerminalKeyboardFocus sends renderer focus state to the window manager", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    preload.api.setTerminalKeyboardFocus(true);
    preload.api.setTerminalKeyboardFocus(false);

    assert.deepEqual(preload.sent, [
      {
        channel: "netcatty:window:set-terminal-keyboard-focus",
        payload: { focused: true },
      },
      {
        channel: "netcatty:window:set-terminal-keyboard-focus",
        payload: { focused: false },
      },
    ]);
  } finally {
    preload.cleanup();
  }
});

test("plugin contribution subscribers share one IPC listener", (t) => {
  const preload = loadPreloadWithFakeElectron();
  t.after(preload.cleanup);
  const observed = Array.from({ length: 20 }, () => 0);
  const unsubscribes = observed.map((_value, index) => (
    preload.api.onPluginContributionsChanged(() => { observed[index] += 1; })
  ));

  assert.equal(
    preload.listenerCounts.get("netcatty:plugins:contributions-changed"),
    1,
    "one window-wide IPC listener should fan out to every subscriber",
  );

  preload.handlers.get("netcatty:plugins:contributions-changed")?.({}, { reason: "test" });
  assert.deepEqual(observed, Array.from({ length: 20 }, () => 1));

  unsubscribes[0]();
  preload.handlers.get("netcatty:plugins:contributions-changed")?.({}, { reason: "test-2" });
  assert.equal(observed[0], 1);
  assert.deepEqual(observed.slice(1), Array.from({ length: 19 }, () => 2));

  for (const unsubscribe of unsubscribes.slice(1)) unsubscribe();
});

test("stream transfer progress enters the unified transfer event interface", async (t) => {
  const preload = loadPreloadWithFakeElectron();
  t.after(preload.cleanup);
  const observed = [];
  const unsubscribe = preload.api.onGlobalSftpTransferEvent((event) => observed.push(event));
  t.after(unsubscribe);

  await preload.api.startStreamTransfer({
    transferId: "verify-phase",
    sourcePath: "/source.bin",
    targetPath: "/target.bin",
    sourceType: "local",
    targetType: "local",
  });
  assert.equal(preload.handlers.has("netcatty:transfer:progress"), false);
  assert.equal(preload.handlers.has("netcatty:transfer:complete"), false);
  assert.equal(preload.handlers.has("netcatty:transfer:error"), false);
  assert.equal(preload.handlers.has("netcatty:transfer:cancelled"), false);
  preload.handlers.get("netcatty:sftp:global-transfer")?.({}, {
    type: "progress",
    transferId: "verify-phase",
    transferred: 10,
    totalBytes: 20,
    speed: 5,
    phase: "verifying",
  });

  assert.deepEqual(observed, [{
    type: "progress",
    transferId: "verify-phase",
    transferred: 10,
    totalBytes: 20,
    speed: 5,
    phase: "verifying",
  }]);
});

test("stores early terminal data until the listener is registered", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "Linux banner\r\n");
  backlog.append("session-1", "root@host:~# ");

  assert.equal(backlog.take("session-1"), "Linux banner\r\nroot@host:~# ");
  assert.equal(backlog.take("session-1"), "");
});

test("keeps each session backlog isolated", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "one");
  backlog.append("session-2", "two");

  assert.equal(backlog.take("session-2"), "two");
  assert.equal(backlog.take("session-1"), "one");
});

test("trims old data when the per-session limit is exceeded", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello");
  backlog.append("session-1", " world");

  assert.equal(backlog.take("session-1"), "world");
});

test("keeps terminal output metadata while trimming backlog data", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello", { droppedOutputMayAffectTerminalState: true });
  backlog.append("session-1", " world");

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "world",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("keeps terminal perf metadata for a single backlog chunk", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 64 });
  const terminalPerf = createTerminalPerfMeta();

  backlog.append("session-1", "hello", { terminalPerf });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "hello",
    meta: { terminalPerf },
  });
});

test("drops terminal perf metadata after backlog data is merged or trimmed", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 8 });

  backlog.append("session-1", "hello", { terminalPerf: createTerminalPerfMeta("perf-1") });
  backlog.append("session-1", " world", {
    terminalPerf: createTerminalPerfMeta("perf-2"),
    droppedOutputMayAffectTerminalState: true,
  });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "lo world",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("sums original plugin-pipeline ingress counts when display chunks are merged", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 8 });
  backlog.append("session-1", "expanded", { pluginPipelineIngressBytes: 3 });
  backlog.append("session-1", "!", { pluginPipelineIngressBytes: 2 });
  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "xpanded!",
    meta: { pluginPipelineIngressBytes: 5 },
  });
});

test("mixed processed and raw backlog uses the renderer flow-control unit", () => {
  const processedThenRaw = createTerminalDataBacklog({ maxBytesPerSession: 64 });
  processedThenRaw.append("session-1", "expanded", { pluginPipelineIngressBytes: 3 });
  processedThenRaw.append("session-1", "普通");
  assert.deepEqual(processedThenRaw.takeEntry("session-1"), {
    data: "expanded普通",
    meta: { pluginPipelineIngressBytes: 5 },
  });

  const rawThenProcessed = createTerminalDataBacklog({ maxBytesPerSession: 64 });
  rawThenProcessed.append("session-1", "普通");
  rawThenProcessed.append("session-1", "expanded", { pluginPipelineIngressBytes: 3 });
  assert.deepEqual(rawThenProcessed.takeEntry("session-1"), {
    data: "普通expanded",
    meta: { pluginPipelineIngressBytes: 5 },
  });
});

test("backlog preserves already-acknowledged replay state and charges only later raw data", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 64 });
  backlog.append("session-1", "prompt __NCM", { pluginPipelineIngressBytes: 0 });
  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "prompt __NCM",
    meta: { pluginPipelineIngressBytes: 0 },
  });

  backlog.append("session-1", "prompt __NCM", { pluginPipelineIngressBytes: 0 });
  backlog.append("session-1", "普通");
  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "prompt __NCM普通",
    meta: { pluginPipelineIngressBytes: 2 },
  });
});

test("sensitive prompt metadata follows the latest merged output chunk", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 64 });
  backlog.append("session-1", "Password: ", {
    pluginPipelineIngressBytes: 10,
    pluginPipelineSensitiveInput: true,
  });
  backlog.append("session-1", "user@host$ ", {
    pluginPipelineIngressBytes: 11,
    pluginPipelineSensitiveInput: false,
  });
  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "Password: user@host$ ",
    meta: {
      pluginPipelineIngressBytes: 21,
      pluginPipelineSensitiveInput: false,
    },
  });
});

test("retains metadata-only plugin output so suppressed data can still be acknowledged", () => {
  const backlog = createTerminalDataBacklog();
  backlog.append("session-1", "", { pluginPipelineIngressBytes: 9 });
  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "",
    meta: { pluginPipelineIngressBytes: 9 },
  });
});

test("retains a zero-ingress plugin readiness marker before listeners attach", () => {
  const backlog = createTerminalDataBacklog();
  backlog.append("session-1", "", { pluginPipelineIngressBytes: 0 });
  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "",
    meta: { pluginPipelineIngressBytes: 0 },
  });
});

test("keeps latest alternate-screen metadata while trimming backlog data", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 5 });

  backlog.append("session-1", "hello", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "enter",
  });
  backlog.append("session-1", " world", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "world",
    meta: {
      droppedOutputMayAffectTerminalState: true,
      droppedOutputAlternateScreenAction: "leave",
    },
  });
});

test("new unknown terminal-state metadata clears stale alternate-screen action in backlog", () => {
  const backlog = createTerminalDataBacklog({ maxBytesPerSession: 64 });

  backlog.append("session-1", "first", {
    droppedOutputMayAffectTerminalState: true,
    droppedOutputAlternateScreenAction: "leave",
  });
  backlog.append("session-1", "second", {
    droppedOutputMayAffectTerminalState: true,
  });

  assert.deepEqual(backlog.takeEntry("session-1"), {
    data: "firstsecond",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("dispatcher writes terminal output metadata into backlog", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliver = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliver("session-1", "early output", { droppedOutputMayAffectTerminalState: true });

  assert.deepEqual(terminalDataBacklog.takeEntry("session-1"), {
    data: "early output",
    meta: { droppedOutputMayAffectTerminalState: true },
  });
});

test("clear drops pending data for a closed session", () => {
  const backlog = createTerminalDataBacklog();

  backlog.append("session-1", "pending");
  backlog.clear("session-1");

  assert.equal(backlog.size("session-1"), 0);
  assert.equal(backlog.take("session-1"), "");
});

test("onSessionData flushes pending terminal data on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "early MOTD\r\n");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const received = [];
  const unsubscribe = api.onSessionData("session-1", (chunk) => {
    received.push(chunk);
  }, { replayBacklog: true });

  assert.deepEqual(received, ["early MOTD\r\n"]);
  assert.equal(terminalDataBacklog.size("session-1"), 0);
  assert.equal(displayDataListeners.get("session-1").size, 1);

  unsubscribe();
  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
});

test("onSessionData replays pending terminal data metadata on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const terminalPerf = createTerminalPerfMeta();
  terminalDataBacklog.append("session-1", "early output", {
    droppedOutputMayAffectTerminalState: true,
    terminalPerf,
  });

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const received = [];
  api.onSessionData("session-1", (chunk, meta) => {
    received.push({ chunk, meta });
  }, { replayBacklog: true });

  assert.deepEqual(received, [{
    chunk: "early output",
    meta: { droppedOutputMayAffectTerminalState: true, terminalPerf },
  }]);
});

test("onSessionData replays metadata-only plugin output on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "", { pluginPipelineIngressBytes: 7 });
  const api = createPreloadApi({
    ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} },
    os: { release: () => "10.0.19045" },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });
  const received = [];
  api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }), {
    replayBacklog: true,
  });
  assert.deepEqual(received, [{
    chunk: "",
    meta: { pluginPipelineIngressBytes: 7 },
  }]);
});

test("onSessionData replays a zero-ingress plugin readiness marker on subscribe", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "", { pluginPipelineIngressBytes: 0 });
  const api = createPreloadApi({
    ipcRenderer: { invoke() {}, send() {}, on() {}, removeListener() {} },
    os: { release: () => "10.0.19045" },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });
  const received = [];
  api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }), {
    replayBacklog: true,
  });
  assert.deepEqual(received, [{
    chunk: "",
    meta: { pluginPipelineIngressBytes: 0 },
  }]);
});

test("legacy terminal data delivery preserves terminal perf metadata", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const terminalPerf = createTerminalPerfMeta();
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "hello",
      meta: { terminalPerf },
    });

    assert.deepEqual(received, [{
      chunk: "hello",
      meta: { terminalPerf },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("legacy terminal data delivery preserves metadata-only plugin output", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "",
      meta: { pluginPipelineIngressBytes: 11 },
    });

    assert.deepEqual(received, [{
      chunk: "",
      meta: { pluginPipelineIngressBytes: 11 },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("legacy MCP-filtered plugin output returns ingress credit immediately", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST",
      meta: { pluginPipelineIngressBytes: 13 },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "\nREADY\n",
    });
    assert.deepEqual(received, [
      { chunk: "", meta: { pluginPipelineIngressBytes: 13 } },
      { chunk: "READY\n", meta: { pluginPipelineIngressBytes: 7 } },
    ]);
  } finally {
    preload.cleanup();
  }
});

test("oversized unterminated MCP marker output stays bounded and hidden", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: `__NCMCP_TEST${"x".repeat(70 * 1024)}`,
    });

    await sleep(100);
    assert.deepEqual(received, []);

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "tail\nREADY\n",
    });
    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: undefined,
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP suppression releases when ConPTY appends the start marker without a newline", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk) => received.push(chunk));
    const send = (data) => preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data,
    });
    const marker = "__NCMCP_release_abcdef0123456789abcdef0123456789__";

    // onEchoSuppressionPrime arms the display filter before the wrapper is typed.
    send(`${marker}_I\n`);
    // The echoed wrapper and the real start marker share one ConPTY row
    // (cursor movement instead of CRLF), and the command output follows on the
    // next row of the same chunk. The filter must release and show it.
    send(`C:\\>set "${marker}=0" & echo ${marker}_S\rinstalled-cmd-ok\r`);
    send("next-line\r\n");
    await sleep(120);

    const delivered = received.join("");
    assert.match(delivered, /installed-cmd-ok/);
    assert.match(delivered, /next-line/);
  } finally {
    preload.cleanup();
  }
});

test("terminal output port delivery preserves terminal perf metadata", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const terminalPerf = createTerminalPerfMeta();
    const received = [];
    const port = createFakePort();
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:terminal-output-port")?.({ ports: [port] }, { sessionId: "session-1" });
    port.emit({
      sessionId: "session-1",
      data: "hello",
      meta: { terminalPerf },
    });

    assert.deepEqual(received, [{
      chunk: "hello",
      meta: { terminalPerf },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("terminal output port delivers metadata-only plugin output for flow acknowledgement", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const port = createFakePort();
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));
    preload.handlers.get("netcatty:terminal-output-port")?.(
      { ports: [port] },
      { sessionId: "session-1" },
    );
    port.emit({
      sessionId: "session-1",
      data: "",
      meta: { pluginPipelineIngressBytes: 11 },
    });
    assert.deepEqual(received, [{
      chunk: "",
      meta: { pluginPipelineIngressBytes: 11 },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("terminal output port delivers a zero-ingress plugin readiness marker", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const port = createFakePort();
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));
    preload.handlers.get("netcatty:terminal-output-port")?.(
      { ports: [port] },
      { sessionId: "session-1" },
    );
    port.emit({
      sessionId: "session-1",
      data: "",
      meta: { pluginPipelineIngressBytes: 0 },
    });
    assert.deepEqual(received, [{
      chunk: "",
      meta: { pluginPipelineIngressBytes: 0 },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered metadata-only plugin output is not applied to the next visible chunk", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const port = createFakePort();
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));
    preload.handlers.get("netcatty:terminal-output-port")?.(
      { ports: [port] },
      { sessionId: "session-1" },
    );
    port.emit({
      sessionId: "session-1",
      data: "__NCMCP_TEST",
      meta: { pluginPipelineIngressBytes: 13 },
    });
    port.emit({
      sessionId: "session-1",
      data: "\nREADY\n",
    });
    assert.deepEqual(received, [
      { chunk: "", meta: { pluginPipelineIngressBytes: 13 } },
      { chunk: "READY\n", meta: { pluginPipelineIngressBytes: 7 } },
    ]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered terminal perf metadata is not carried to later output", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { terminalPerf: createTerminalPerfMeta() },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: undefined,
    }]);
  } finally {
    preload.cleanup();
  }
});

test("delayed MCP terminal data flush preserves metadata", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "prompt __NCM",
      meta: { droppedOutputMayAffectTerminalState: true },
    });

    assert.deepEqual(received, []);
    await sleep(100);

    assert.deepEqual(received, [{
      chunk: "prompt __NCM",
      meta: { droppedOutputMayAffectTerminalState: true },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("already-acknowledged MCP prefix flushes visible text with explicit zero credit", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "prompt __NCM",
      meta: { pluginPipelineIngressBytes: 13 },
    });

    assert.deepEqual(received, [{
      chunk: "",
      meta: { pluginPipelineIngressBytes: 13 },
    }]);
    await sleep(100);

    assert.deepEqual(received, [
      { chunk: "", meta: { pluginPipelineIngressBytes: 13 } },
      { chunk: "prompt __NCM", meta: { pluginPipelineIngressBytes: 0 } },
    ]);
  } finally {
    preload.cleanup();
  }
});

test("already-acknowledged MCP prefix charges only a later safe continuation", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => received.push({ chunk, meta }));
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "prompt __NCM",
      meta: { pluginPipelineIngressBytes: 13 },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "X\n",
    });

    assert.deepEqual(received, [
      { chunk: "", meta: { pluginPipelineIngressBytes: 13 } },
      { chunk: "prompt __NCMX\n", meta: { pluginPipelineIngressBytes: 2 } },
    ]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered empty terminal data carries metadata to next visible output", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP metadata merge clears stale alternate-screen action on later unknown risk", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: {
        droppedOutputMayAffectTerminalState: true,
        droppedOutputAlternateScreenAction: "leave",
      },
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered empty terminal metadata is cleared on session exit", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    }, { replayBacklog: true });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed",
    });
    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{
      chunk: "READY\n",
      meta: undefined,
    }]);
  } finally {
    preload.cleanup();
  }
});

test("MCP-filtered tail metadata is cleared on acknowledged close without an exit event", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    preload.api.onSessionData("session-1", () => {});
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "__NCMCP_TEST\n",
      meta: { droppedOutputMayAffectTerminalState: true },
    });

    // Some protocol close paths intentionally suppress their later exit event.
    await preload.api.closeSession("session-1");
    await preload.api.startLocalSession({ sessionId: "session-1" });

    const received = [];
    preload.api.onSessionData("session-1", (chunk, meta) => {
      received.push({ chunk, meta });
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "READY\n",
    });

    assert.deepEqual(received, [{ chunk: "READY\n", meta: undefined }]);
  } finally {
    preload.cleanup();
  }
});

test("non-display listeners do not drain pending terminal data", () => {
  const dataListeners = new Map();
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "early prompt");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  const observerReceived = [];
  const displayReceived = [];

  api.onSessionData("session-1", (chunk) => {
    observerReceived.push(chunk);
  });
  assert.deepEqual(observerReceived, []);
  assert.equal(terminalDataBacklog.size("session-1"), "early prompt".length);

  api.onSessionData("session-1", (chunk) => {
    displayReceived.push(chunk);
  }, { replayBacklog: true });

  assert.deepEqual(observerReceived, []);
  assert.deepEqual(displayReceived, ["early prompt"]);
  assert.equal(terminalDataBacklog.size("session-1"), 0);
});

test("keeps early data for display replay while only observer listeners exist", () => {
  const observed = [];
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk)])],
  ]);
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliverToListeners("session-1", "Linux banner\r\n");

  assert.deepEqual(observed, ["Linux banner\r\n"]);
  assert.equal(terminalDataBacklog.take("session-1"), "Linux banner\r\n");
});

test("does not backlog data once the display listener is registered", () => {
  const observed = [];
  const displayed = [];
  const displayListener = (chunk) => displayed.push(chunk);
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk), displayListener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([displayListener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  });

  deliverToListeners("session-1", "live output");

  assert.deepEqual(observed, ["live output"]);
  assert.deepEqual(displayed, ["live output"]);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("drops terminal data for sessions marked closed", () => {
  const observed = [];
  const dataListeners = new Map([
    ["session-1", new Set([(chunk) => observed.push(chunk)])],
  ]);
  const displayDataListeners = new Map();
  const terminalDataBacklog = createTerminalDataBacklog();
  const closedSessions = new Set(["session-1"]);
  const deliverToListeners = createTerminalDataDispatcher({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
    shouldDropSession: (sessionId) => closedSessions.has(sessionId),
  });

  deliverToListeners("session-1", "late output");

  assert.deepEqual(observed, []);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("clearTerminalDataSession drops listener and backlog state together", () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "pending");

  clearTerminalDataSession({
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
  }, "session-1");

  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("clearTerminalDataBacklog preserves live display listeners for reconnect", () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  terminalDataBacklog.append("session-1", "pending");

  clearTerminalDataBacklog({ terminalDataBacklog }, "session-1");

  assert.equal(dataListeners.get("session-1")?.has(listener), true);
  assert.equal(displayDataListeners.get("session-1")?.has(listener), true);
  assert.equal(terminalDataBacklog.take("session-1"), "");
});

test("backend exit preserves live listeners for same-id reconnect", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const exits = [];
    preload.api.onSessionData("session-1", (chunk) => {
      received.push(chunk);
    }, { replayBacklog: true });
    preload.api.onSessionExit("session-1", (evt) => {
      exits.push(evt.reason);
    });

    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "before exit",
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed",
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "duplicate-closed",
    });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "dropped while closed",
    });
    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:data")?.({}, {
      sessionId: "session-1",
      data: "after reconnect",
    });
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed-again",
    });

    assert.deepEqual(received, ["before exit", "after reconnect"]);
    assert.deepEqual(exits, ["closed", "closed-again"]);
  } finally {
    preload.cleanup();
  }
});

test("zmodem events after explicit close and backend exit are gated", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const zmodemEvents = [];
    const overwriteRequests = [];
    preload.api.onZmodemEvent("session-1", (evt) => {
      zmodemEvents.push(evt.type);
    });
    preload.api.onZmodemOverwriteRequest("session-1", (payload) => {
      overwriteRequests.push(payload.sessionId);
    });

    preload.api.closeSession("session-1");
    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "closed",
    });
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    preload.handlers.get("netcatty:zmodem:overwrite-request")?.({}, {
      sessionId: "session-1",
    });

    assert.deepEqual(zmodemEvents, []);
    assert.deepEqual(overwriteRequests, []);
  } finally {
    preload.cleanup();
  }
});

test("zmodem listeners survive backend exit and fire after same-session reconnect", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const zmodemEvents = [];
    const overwriteRequests = [];
    preload.api.onZmodemEvent("session-1", (evt) => {
      zmodemEvents.push(evt.type);
    });
    preload.api.onZmodemOverwriteRequest("session-1", (payload) => {
      overwriteRequests.push(payload);
    });

    preload.handlers.get("netcatty:exit")?.({}, {
      sessionId: "session-1",
      reason: "error",
    });
    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    preload.handlers.get("netcatty:zmodem:overwrite-request")?.({}, {
      sessionId: "session-1",
      requestId: "r1",
      filename: "f",
    });

    assert.deepEqual(zmodemEvents, ["detect"]);
    assert.deepEqual(overwriteRequests, [{
      sessionId: "session-1",
      requestId: "r1",
      filename: "f",
    }]);
  } finally {
    preload.cleanup();
  }
});

test("zmodem listeners survive reconnect-style closeSession and resume after restart", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const zmodemEvents = [];
    const overwriteRequests = [];
    preload.api.onZmodemEvent("session-1", (evt) => {
      zmodemEvents.push(evt.type);
    });
    preload.api.onZmodemOverwriteRequest("session-1", (payload) => {
      overwriteRequests.push(payload.requestId);
    });

    // Reconnect path: closeSession is called while the terminal component
    // stays mounted, then the session restarts with the same id.
    preload.api.closeSession("session-1");
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    assert.deepEqual(zmodemEvents, []);

    await preload.api.startLocalSession({ sessionId: "session-1" });
    preload.handlers.get("netcatty:zmodem:detect")?.({}, {
      sessionId: "session-1",
    });
    preload.handlers.get("netcatty:zmodem:overwrite-request")?.({}, {
      sessionId: "session-1",
      requestId: "r1",
      filename: "f",
    });

    assert.deepEqual(zmodemEvents, ["detect"]);
    assert.deepEqual(overwriteRequests, ["r1"]);
  } finally {
    preload.cleanup();
  }
});

test("onWindowFocusRequested is wired to the focus-requested IPC", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const calls = [];
    const unsubscribe = preload.api.onWindowFocusRequested(() => {
      calls.push("focus");
    });

    preload.handlers.get("netcatty:window:focus-requested")?.();

    assert.deepEqual(calls, ["focus"]);

    unsubscribe();
    preload.handlers.get("netcatty:window:focus-requested")?.();

    assert.deepEqual(calls, ["focus"]);
  } finally {
    preload.cleanup();
  }
});

test("onZmodemEvent unsubscribe removes empty listener set", () => {
  const zmodemListeners = new Map();
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    zmodemListeners,
  });

  const off = api.onZmodemEvent("session-1", () => {});
  assert.equal(zmodemListeners.has("session-1"), true);

  off();

  assert.equal(zmodemListeners.has("session-1"), false);
});

test("onSessionExit unsubscribe removes empty listener set", () => {
  const exitListeners = new Map();
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    exitListeners,
  });

  const off = api.onSessionExit("session-1", () => {});
  assert.equal(exitListeners.has("session-1"), true);

  off();

  assert.equal(exitListeners.has("session-1"), false);
});

test("session-scoped terminal listener unsubscribe removes empty listener sets", () => {
  const listenerMaps = {
    telnetAutoLoginCompleteListeners: new Map(),
    telnetAutoLoginCancelledListeners: new Map(),
    moshSessionReadyListeners: new Map(),
    telnetEchoModeListeners: new Map(),
    authFailedListeners: new Map(),
  };
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    ...listenerMaps,
  });
  const subscriptions = [
    ["telnetAutoLoginCompleteListeners", api.onTelnetAutoLoginComplete],
    ["telnetAutoLoginCancelledListeners", api.onTelnetAutoLoginCancelled],
    ["moshSessionReadyListeners", api.onMoshSessionReady],
    ["telnetEchoModeListeners", api.onTelnetEchoMode],
    ["authFailedListeners", api.onAuthFailed],
  ];

  for (const [mapName, subscribe] of subscriptions) {
    const off = subscribe("session-1", () => {});
    assert.equal(listenerMaps[mapName].has("session-1"), true, `${mapName} should register`);
    off();
    assert.equal(listenerMaps[mapName].has("session-1"), false, `${mapName} should release its empty session entry`);
  }
});

test("backend exit clears auth-failure listeners for the closed session", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    let calls = 0;
    preload.api.onAuthFailed("session-1", () => { calls += 1; });

    preload.handlers.get("netcatty:exit")?.({}, { sessionId: "session-1" });
    preload.handlers.get("netcatty:auth:failed")?.({}, { sessionId: "session-1" });

    assert.equal(calls, 0);
  } finally {
    preload.cleanup();
  }
});

test("closeSession clears terminal data state and waits for close acknowledgement", async () => {
  const listener = () => {};
  const dataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const displayDataListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const terminalDataBacklog = createTerminalDataBacklog();
  const closedTerminalDataSessions = new Set();
  const telnetEchoModeListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const telnetAutoLoginCompleteListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const telnetAutoLoginCancelledListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const moshSessionReadyListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const authFailedListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const zmodemListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const zmodemOverwriteListeners = new Map([
    ["session-1", new Set([listener])],
  ]);
  const invoked = [];
  const closedPorts = [];
  terminalDataBacklog.append("session-1", "pending");

  const api = createPreloadApi({
    ipcRenderer: {
      invoke(channel, payload) {
        invoked.push({ channel, payload });
        return Promise.resolve();
      },
      send(channel, payload) {
        throw new Error(`unexpected send ${channel}`);
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners,
    displayDataListeners,
    terminalDataBacklog,
    closedTerminalDataSessions,
    telnetEchoModeListeners,
    telnetAutoLoginCompleteListeners,
    telnetAutoLoginCancelledListeners,
    moshSessionReadyListeners,
    authFailedListeners,
    zmodemListeners,
    zmodemOverwriteListeners,
    terminalOutputPorts: {
      closeSession(sessionId) {
        closedPorts.push(sessionId);
      },
    },
  });

  await api.closeSession("session-1");

  assert.equal(dataListeners.has("session-1"), false);
  assert.equal(displayDataListeners.has("session-1"), false);
  assert.equal(terminalDataBacklog.take("session-1"), "");
  assert.equal(closedTerminalDataSessions.has("session-1"), true);
  assert.equal(telnetEchoModeListeners.has("session-1"), false);
  assert.equal(telnetAutoLoginCompleteListeners.has("session-1"), false);
  assert.equal(telnetAutoLoginCancelledListeners.has("session-1"), false);
  assert.equal(moshSessionReadyListeners.has("session-1"), false);
  assert.equal(authFailedListeners.has("session-1"), false);
  // Zmodem listeners are preserved: reconnect closes the session without
  // unmounting the subscriber, so cleanup is left to subscriber dispose.
  assert.equal(zmodemListeners.has("session-1"), true);
  assert.equal(zmodemOverwriteListeners.has("session-1"), true);
  assert.deepEqual(closedPorts, ["session-1"]);
  assert.deepEqual(invoked, [
    { channel: "netcatty:close:await", payload: { sessionId: "session-1" } },
  ]);
});

test("closeSession falls back to fire-and-forget close when acknowledgement is unavailable", async () => {
  const sent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {
        return Promise.reject(new Error("missing handler"));
      },
      send(channel, payload) {
        sent.push({ channel, payload });
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    closedTerminalDataSessions: new Set(),
    telnetEchoModeListeners: new Map(),
  });

  await api.closeSession("session-1");

  assert.deepEqual(sent, [
    { channel: "netcatty:close", payload: { sessionId: "session-1" } },
  ]);
});

test("interruptSession uses the urgent input port before falling back to IPC", () => {
  const sent = [];
  const urgent = [];
  const api = createPreloadApi({
    ipcRenderer: {
      invoke() {},
      send(channel, payload) {
        sent.push({ channel, payload });
      },
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    terminalUrgentInputPorts: {
      postInterrupt(sessionId, trace) {
        urgent.push({ sessionId, trace });
        return true;
      },
    },
  });

  api.interruptSession("session-1", {
    traceId: "trace-1",
    rendererKeyAt: 123,
  });

  assert.deepEqual(urgent, [
    {
      sessionId: "session-1",
      trace: {
        traceId: "trace-1",
        rendererKeyAt: 123,
        rendererHasSelection: false,
        debug: false,
        rendererPriority: undefined,
        rendererSendAt: undefined,
        rendererStatus: undefined,
        sessionId: undefined,
        source: undefined,
      },
    },
  ]);
  assert.deepEqual(sent, []);
});

test("startLocalSession reopens a previously closed terminal data session", async () => {
  const closedTerminalDataSessions = new Set(["session-1"]);
  const invoked = [];
  const api = createPreloadApi({
    ipcRenderer: {
      async invoke(channel, payload) {
        invoked.push({ channel, payload, wasClosed: closedTerminalDataSessions.has("session-1") });
        return { sessionId: "session-1" };
      },
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    closedTerminalDataSessions,
    telnetEchoModeListeners: new Map(),
  });

  const sessionId = await api.startLocalSession({ sessionId: "session-1" });

  assert.equal(sessionId, "session-1");
  assert.deepEqual(invoked, [
    {
      channel: "netcatty:local:start",
      payload: { sessionId: "session-1" },
      wasClosed: false,
    },
  ]);
  assert.equal(closedTerminalDataSessions.has("session-1"), false);
});

test("startPluginConnection reopens a previously closed terminal data session", async () => {
  const closedTerminalDataSessions = new Set(["session-1"]);
  const invoked = [];
  const api = createPreloadApi({
    ipcRenderer: {
      async invoke(channel, payload) {
        invoked.push({ channel, payload, wasClosed: closedTerminalDataSessions.has("session-1") });
        return {
          sessionId: "session-1",
          providerId: "com.example.transport.connection",
          status: "connected",
          diagnostics: [],
        };
      },
      send() {},
      on() {},
      removeListener() {},
    },
    os: {
      release: () => "10.0.19045",
    },
    dataListeners: new Map(),
    displayDataListeners: new Map(),
    terminalDataBacklog: createTerminalDataBacklog(),
    closedTerminalDataSessions,
    telnetEchoModeListeners: new Map(),
  });

  const result = await api.startPluginConnection({
    sessionId: "session-1",
    providerId: "com.example.transport.connection",
    configuration: {},
  });

  assert.deepEqual(result, {
    sessionId: "session-1",
    providerId: "com.example.transport.connection",
    status: "connected",
    diagnostics: [],
  });
  assert.equal(invoked[0].channel, "netcatty:plugins:connection-start");
  assert.equal(invoked[0].payload.sessionId, "session-1");
  assert.equal(invoked[0].payload.providerId, "com.example.transport.connection");
  assert.equal(invoked[0].wasClosed, false);
  assert.equal(closedTerminalDataSessions.has("session-1"), false);
});


test("live-shell probe suppresses the intermediate prompt across chunks", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("probe-session", (chunk) => received.push(chunk));
    for (const data of [
      "__NCMCP_probe___P:bash\r\n",
      "__NCMCP_probe___Q",
      "user@host:~$ ",
      " __NCMCP_probe__=0; wrapped-command\r\n",
      "__NCMCP_probe___S\r\n",
      "file.txt\r\n",
    ]) {
      preload.handlers.get("netcatty:data")({}, { sessionId: "probe-session", data });
    }
    assert.equal(received.join(""), "file.txt\r\n");
  } finally {
    preload.cleanup();
  }
});


test("live-shell probe buffers echoed builtin prefixes until the marker arrives", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("probe-echo", (chunk) => received.push(chunk));
    for (const data of [" tru", "e __NCM", "CP_probe__; probe-command\r\n", "file.txt\r\n"]) {
      preload.handlers.get("netcatty:data")({}, { sessionId: "probe-echo", data });
    }
    assert.equal(received.join(""), "file.txt\r\n");
  } finally {
    preload.cleanup();
  }
});

test("ordinary text resembling the probe prefix is eventually delivered", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("ordinary-text", (chunk) => received.push(chunk));
    preload.handlers.get("netcatty:data")({}, { sessionId: "ordinary-text", data: "ordinary tru" });
    await sleep(120);
    assert.equal(received.join(""), "ordinary tru");
  } finally {
    preload.cleanup();
  }
});


test("slow echo-disabled probe prompt stays hidden across delayed flushes", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("slow-probe", (chunk) => received.push(chunk));
    const send = (data) => preload.handlers.get("netcatty:data")({}, { sessionId: "slow-probe", data });
    send("__NCMCP_probe___Q");
    await sleep(120);
    assert.equal(received.join(""), "");
    send("slow prompt> ");
    await sleep(120);
    assert.equal(received.join(""), "");
    send("\r\n__NCMCP_probe___S\r\nfile.txt\r\n");
    assert.equal(received.join(""), "file.txt\r\n");
  } finally {
    preload.cleanup();
  }
});

test("split probe completion markers stay hidden across delayed flushes", async () => {
  for (const prefix of ["__NCMCP_", "__NCMCP_probe___"]) {
    const preload = loadPreloadWithFakeElectron();
    try {
      const received = [];
      preload.api.onSessionData("split-probe", (chunk) => received.push(chunk));
      const send = (data) => preload.handlers.get("netcatty:data")({}, { sessionId: "split-probe", data });
      send(prefix);
      await sleep(120);
      assert.equal(received.join(""), "");
      send("__NCMCP_probe___Q".slice(prefix.length) + "slow prompt> ");
      await sleep(120);
      assert.equal(received.join(""), "");
      send("\r\n__NCMCP_probe___S\r\nfile.txt\r\n");
      assert.equal(received.join(""), "file.txt\r\n");
    } finally {
      preload.cleanup();
    }
  }
});

test("multiline probe prompts remain hidden until the matching command starts", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("multiline-probe", (chunk) => received.push(chunk));
    const send = (data) => preload.handlers.get("netcatty:data")({}, { sessionId: "multiline-probe", data });
    send("__NCMCP_probe___");
    await sleep(120);
    send("Qfirst prompt line\r\nsecond prompt line\r\n> ");
    await sleep(120);
    send("__NCMCP_other___S\r\nstill prompt\r\n");
    assert.equal(received.join(""), "");
    send("\r\n__NCMCP_probe___S\r\nfile.txt\r\n");
    assert.equal(received.join(""), "file.txt\r\n");
  } finally {
    preload.cleanup();
  }
});

test("aborted probes release multiline suppression and ignore a late completion", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("aborted-probe", (chunk) => received.push(chunk));
    const send = (data) => preload.handlers.get("netcatty:data")({}, { sessionId: "aborted-probe", data });
    send("__NCMCP_probe___Qfirst prompt\r\nsecond prompt\r\n");
    send("__NCMCP_probe___R\r\n");
    send("normal output\r\n");
    send("__NCMCP_buffered___Q");
    send("__NCMCP_buffered___R\r\n");
    send("after buffered cancellation\r\n");
    send("__NCMCP_late___R\r\n");
    send("__NCMCP_late___Q\r\nlate prompt\r\n");
    assert.equal(received.join(""), "normal output\r\nafter buffered cancellation\r\nlate prompt\r\n");
  } finally {
    preload.cleanup();
  }
});

test("real PTY multiline prompt is displayed only after the AI command", {
  skip: process.env.NETCATTY_LIVE_FISH_TEST !== "1", timeout: 10000,
}, async () => {
  const preload = loadPreloadWithFakeElectron();
  const terminal = require("node-pty").spawn("/bin/bash", ["--noprofile", "--norc", "--noediting"], {
    name: "dumb", cols: 240, rows: 24,
    env: { ...process.env, TERM: "dumb", PS1: "FIRST_LINE\nLAST_LINE> ", BASH_SILENCE_DEPRECATION_WARNING: "1" },
  });
  let raw = "";
  const received = [];
  const send = (data) => preload.handlers.get("netcatty:data")({}, { sessionId: "real-multiline", data });
  preload.api.onSessionData("real-multiline", (data) => received.push(data));
  terminal.onData((data) => { raw += data; send(data); });
  const ready = async () => {
    const deadline = Date.now() + 3000;
    while (!raw.includes("LAST_LINE>")) {
      if (Date.now() > deadline) throw new Error("Missing multiline shell prompt");
      await sleep(10);
    }
    raw = "";
  };
  try {
    await ready();
    terminal.write("stty -echo\r");
    await ready();
    received.length = 0;
    const result = await require("./bridges/ai/ptyExec.cjs").execViaPty(terminal, "printf 'visible-result\\n'", {
      shellKind: "posix", probeLiveShell: true, stripMarkers: true, timeoutMs: 3000,
      onProbeAborted: (marker) => send(`${marker}_R\n`),
    });
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    await sleep(160);
    const display = received.join("");
    assert.match(display, /visible-result/);
    assert.equal((display.match(/FIRST_LINE/g) || []).length, 1, display);
    assert.equal((display.match(/LAST_LINE/g) || []).length, 1, display);
    assert.equal(display.includes("__NCMCP_"), false, display);
  } finally {
    terminal.kill();
    preload.cleanup();
  }
});

test("OpenWrt bounded wrapper continuations stay hidden across fragmented echoes", () => {
  const { buildWrappedCommand } = require('./bridges/ai/ptyExecHelpers.cjs');
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const sessionId = 'openwrt-echo';
    const marker = '__NCMCP_mttikd5b_ccbc892e865a115a80c88afdc77b96a6__';
    preload.api.onSessionData(sessionId, chunk => received.push(chunk));
    preload.handlers.get("netcatty:data")({}, { sessionId, data: `${marker}_I\n` });
    const wrapped = buildWrappedCommand("printf 'visible-output\\n'", 'posix', marker);
    const echo = wrapped.trimEnd().split('\n').map((line, index) => `${index ? '> ' : ''}${line}\r\n`).join('');
    const data = `${echo}${marker}_S\r\nvisible-output\r\n${marker}_E:0\r\n`;
    for (let offset = 0; offset < data.length; offset += 7) {
      preload.handlers.get('netcatty:data')({}, { sessionId, data: data.slice(offset, offset + 7) });
    }
    assert.equal(received.join(''), 'visible-output\r\n');
  } finally {
    preload.cleanup();
  }
});

test("primed suppression hides BusyBox ash echo wrapped mid-marker (#3384)", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    const sessionId = 'ash-wrap';
    const marker = '__NCMCP_mttikd5b_ccbc892e865a115a80c88afdc77b96a6__';
    preload.api.onSessionData(sessionId, chunk => received.push(chunk));
    // The exec bridge primes display suppression over the data channel before
    // the wrapper is typed, mirroring onEchoSuppressionPrime in ptyExec.cjs.
    preload.handlers.get('netcatty:data')({}, { sessionId, data: `${marker}_I\n` });
    // BusyBox ash's line editor breaks the echoed first wrapper line at the
    // terminal width, so the second PTY line carries no complete __NCMCP_
    // marker and the per-line echo filter alone cannot drop it.
    const firstLine = ` ${marker}=0; printf '\\n%s\\n' '${marker}_I'`;
    const secondLine = ` : '${marker}'; ${marker}_cmd='echo visible-output'; \\`;
    const echo = `${firstLine.slice(0, 55)}\r\n${firstLine.slice(55)}\r\n`
      + `${secondLine.slice(0, 70)}\r\n${secondLine.slice(70)}\r\n`
      + `> : '${marker}'; printf '%s\\n' '${marker}_S'\r\n`;
    const data = `${echo}\n${marker}_S\r\nvisible-output\r\n${marker}_E:0\r\n`;
    for (let offset = 0; offset < data.length; offset += 7) {
      preload.handlers.get('netcatty:data')({}, { sessionId, data: data.slice(offset, offset + 7) });
    }
    assert.equal(received.join(''), 'visible-output\r\n');
  } finally {
    preload.cleanup();
  }
});


test("ordinary text resembling an OpenWrt continuation is released", async () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("ordinary-continuation", chunk => received.push(chunk));
    preload.handlers.get("netcatty:data")({}, { sessionId: "ordinary-continuation", data: "> : '" });
    await sleep(120);
    assert.equal(received.join(""), "> : '");
  } finally {
    preload.cleanup();
  }
});

for (const echo of [true, false]) {
  test(`real PTY hides custom multiline secondary prompts (echo=${echo})`, {
    skip: process.env.NETCATTY_LIVE_FISH_TEST !== '1', timeout: 10000,
  }, async () => {
    const preload = loadPreloadWithFakeElectron();
    const terminal = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc', '--noediting'], {
      name: 'dumb', cols: 240, rows: 24,
      env: { ...process.env, TERM: 'dumb', PS1: 'READY> ', PS2: 'CUSTOM\nCONT> ', BASH_SILENCE_DEPRECATION_WARNING: '1' },
    });
    const received = [];
    let raw = '';
    const send = data => preload.handlers.get('netcatty:data')({}, { sessionId: 'custom-ps2', data });
    preload.api.onSessionData('custom-ps2', data => received.push(data));
    terminal.onData(data => { raw += data; send(data); });
    const ready = async () => {
      const deadline = Date.now() + 3000;
      while (!raw.includes('READY> ')) {
        if (Date.now() > deadline) throw new Error('Missing Bash prompt');
        await sleep(10);
      }
      raw = '';
      await sleep(120);
    };
    try {
      await ready();
      if (!echo) { terminal.write('stty -echo\r'); await ready(); }
      for (const probeLiveShell of [false, true]) {
        received.length = 0;
        const result = await require('./bridges/ai/ptyExec.cjs').execViaPty(terminal, "printf 'visible-result\\n'", {
          shellKind: 'posix', probeLiveShell, stripMarkers: true, timeoutMs: 3000,
          onProbeAborted: (marker) => send(`${marker}_R\n`),
        });
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        await sleep(160);
        const display = received.join('');
        assert.match(display, /visible-result/);
        assert.doesNotMatch(display, /CUSTOM|CONT>|__NCMCP_/, JSON.stringify({ display, raw }));
        assert.match(display, /READY> /);
      }
    } finally { terminal.kill(); preload.cleanup(); }
  });
}


test("aborted input releases custom prompts and ignores a late input marker", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const received = [];
    preload.api.onSessionData("aborted-input", data => received.push(data));
    const send = data => preload.handlers.get("netcatty:data")({}, { sessionId: "aborted-input", data });
    send("__NCMCP_input___I\nCUSTOM\nCONT> ");
    send("__NCMCP_input___R\n");
    send("normal output\n");
    send("__NCMCP_input___I\nlate prompt\n");
    assert.equal(received.join(""), "normal output\nlate prompt\n");
  } finally { preload.cleanup(); }
});

test('real OpenWrt ash hides wrapped input and preserves output with priming (#3384)', {
  skip: !process.env.NETCATTY_OPENWRT_SSH_PORT,
  timeout: 60000,
}, async () => {
  const { Client } = require('ssh2');
  const { execViaPty } = require('./bridges/ai/ptyExec.cjs');
  const client = new Client();
  await new Promise((resolve, reject) => client.once('ready', resolve).once('error', reject).connect({
    host: '127.0.0.1', port: Number(process.env.NETCATTY_OPENWRT_SSH_PORT), username: 'root', password: '',
  }));
  try {
    for (const cols of [80, 120]) {
      for (const probeLiveShell of [false, true]) {
        const preload = loadPreloadWithFakeElectron();
        const stream = await new Promise((resolve, reject) => client.shell({ term: 'xterm', cols, rows: 30 },
          (error, value) => error ? reject(error) : resolve(value)));
        try {
          await new Promise((resolve, reject) => {
            let output = '';
            const timer = setTimeout(() => reject(new Error('OpenWrt prompt missing')), 5000);
            const onData = data => {
              output += data;
              if (output.includes(':~# ')) {
                clearTimeout(timer);
                stream.removeListener('data', onData);
                resolve();
              }
            };
            stream.on('data', onData);
          });
          const received = [];
          const sessionId = `openwrt-${cols}-${probeLiveShell}`;
          preload.api.onSessionData(sessionId, chunk => received.push(chunk));
          const deliver = data => preload.handlers.get('netcatty:data')({}, { sessionId, data: String(data) });
          stream.on('data', deliver);
          const result = await execViaPty(stream, "printf 'visible-output\\n'", {
            shellKind: 'posix', probeLiveShell, typedInput: true, timeoutMs: 5000,
            onEchoSuppressionPrime: marker => deliver(`${marker}_I\n`),
            onProbeAborted: marker => deliver(`${marker}_R\n`),
          });
          await sleep(150);
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.stdout.trim(), 'visible-output');
          const display = received.join('');
          assert.match(display, /visible-output/);
          assert.doesNotMatch(display, /__nc_|__NCMCP_|printf|eval|unset|_cmd=|_d=/,
            JSON.stringify({ cols, probeLiveShell, display }));
        } finally {
          stream.close();
          preload.cleanup();
        }
      }
    }
  } finally {
    client.end();
  }
});

test("MCP suppression does not release on an echoed start marker at a chunk boundary", (t) => {
  const preload = loadPreloadWithFakeElectron();
  t.after(preload.cleanup);
  const received = [];
  preload.api.onSessionData("split-start", (data) => received.push(data));
  const send = (data) => preload.handlers.get("netcatty:data")({}, { sessionId: "split-start", data });
  const marker = "__NCMCP_split_start__";
  send(`${marker}_I\r\n`);
  send(`C:\\>set x=0 & echo ${marker}_S`);
  send(" & wrapper-must-stay-hidden\r\n");
  send(`${marker}_S\r\nvisible\r\n${marker}_E:0\r\nC:\\>`);
  assert.equal(received.join(""), "visible\r\nC:\\>");
});

function createMcpReplayHarness(preload, transport, sessionId, received) {
  preload.api.onSessionData(sessionId, (data, meta) => received.push({ data, meta }));
  if (transport === "port") {
    const port = createFakePort();
    preload.handlers.get("netcatty:terminal-output-port")({ ports: [port] }, { sessionId });
    return (data, meta) => port.emit({ sessionId, data, meta });
  }
  return (data, meta) => preload.handlers.get("netcatty:data")({}, { sessionId, data, meta });
}

for (const transport of ["legacy", "port"]) {
  for (const oneCharacterChunks of [false, true]) {
    test(`CMD ConPTY replay keeps all output and prompts via ${transport}, split=${oneCharacterChunks}`, async (t) => {
      const preload = loadPreloadWithFakeElectron();
      t.after(preload.cleanup);
      const fixture = require("./preload/fixtures/cmd-agent-conpty.json");
      const received = [];
      const send = createMcpReplayHarness(preload, transport, "cmd-replay", received);
      let ingressBytes = 0;
      for (const event of fixture.events) {
        if (event.type === "prime") { send(event.data); continue; }
        const chunks = oneCharacterChunks ? [...event.data] : [event.data];
        for (const data of chunks) {
          ingressBytes += data.length;
          send(data, { pluginPipelineIngressBytes: data.length });
        }
      }
      await sleep(100);
      const { createMcpOscFilter } = require("./preload/mcpOscFilter.cjs");
      const output = createMcpOscFilter().split("display", received.map((item) => item.data).join(""))
        .filter((part) => part.kind === "text").map((part) => part.data).join("");
      for (const text of ["one-ok", "two-ok", "three-ok"]) {
        assert.equal(output.split(text).length - 1, 1, `${text} must be shown once`);
      }
      assert.equal(output.split("C:\\Users\\agent>").length - 1, 3, "every command must restore its prompt");
      assert.doesNotMatch(output, /__NCMCP_|call cmd|errorlevel/i);
      assert.equal(received.reduce((total, item) => total + (item.meta?.pluginPipelineIngressBytes || 0), 0), ingressBytes);
    });
  }
}

for (const transport of ["legacy", "port"]) {
  test(`OSC titles never release MCP suppression via ${transport}`, (t) => {
    const preload = loadPreloadWithFakeElectron();
    t.after(preload.cleanup);
    const received = [];
    const send = createMcpReplayHarness(preload, transport, "osc-probe", received);
    const marker = "__NCMCP_osc_probe__";
    send("\u001b]0;old title ");
    send(`${marker}_I\r\n`);
    send(`echo ${marker}_S\u001b\\`);
    send("wrapper-must-stay-hidden\r\n");
    send(`${marker}_S \r\nvisible\r\n${marker}_E:0\r\nC:\\>`);
    assert.equal(received.map((item) => item.data).join(""), "visible\r\nC:\\>");
  });
}

for (const transport of ["legacy", "port"]) {
  test(`partial OSC preserves bytes and ingress without stale perf via ${transport}`, (t) => {
    const preload = loadPreloadWithFakeElectron();
    t.after(preload.cleanup);
    const received = [];
    const send = createMcpReplayHarness(preload, transport, "osc-meta", received);
    const first = "prefix\u001b]0;CMD";
    const second = " title\u0007\u001b]8;;https://example.test/__NCMCP_link___S\u001b\\"
      + "shown\u001b]8;;\u001b\\";
    send(first, { terminalPerf: createTerminalPerfMeta("old"), pluginPipelineIngressBytes: first.length });
    send(second, { terminalPerf: createTerminalPerfMeta("new"), pluginPipelineIngressBytes: second.length });
    assert.equal(received.map((item) => item.data).join(""), first + second);
    assert.ok(received.every((item) => !item.meta?.terminalPerf));
    const terminalPerf = createTerminalPerfMeta("fresh");
    send("fresh", { terminalPerf, pluginPipelineIngressBytes: 5 });
    assert.deepEqual(received.at(-1), { data: "fresh", meta: { terminalPerf, pluginPipelineIngressBytes: 5 } });
    assert.equal(received.reduce((total, item) => total + (item.meta?.pluginPipelineIngressBytes || 0), 0), first.length + second.length + 5);
  });
}


for (const transport of ["legacy", "port"]) {
  for (const chunks of ["whole", "characters"]) {
    test(`opaque OSC stays ordered after a visible marker-prefix suffix via ${transport} (${chunks})`, (t) => {
      const preload = loadPreloadWithFakeElectron();
      t.after(preload.cleanup);
      const received = [];
      const send = createMcpReplayHarness(preload, transport, "osc-order", received);
      const input = "prefix_\u001b]0;ordinary title\u0007suffix\r\n"
        + "\u001b]8;;https://example.test/__NCMCP_link___S\u001b\\"
        + "link_\u001b]8;;\u001b\\after\r\n";
      for (const chunk of chunks === "whole" ? [input] : [...input]) {
        send(chunk, { pluginPipelineIngressBytes: chunk.length });
      }
      assert.equal(received.map((item) => item.data).join(""), input);
      assert.equal(received.reduce((total, item) => total + (item.meta?.pluginPipelineIngressBytes || 0), 0), input.length);
    });
  }
}

for (const transport of ["legacy", "port"]) {
  test(`ConPTY cursor boundaries stay ordered through ${transport}, including split CRLF`, () => {
    const preload = loadPreloadWithFakeElectron();
    try {
      const sessionId = "conpty-cursor-test";
      const marker = "__NCMCP_cursor___";
      const sync = "\u001b]633;NetcattyMcpCursorSync\u0007";
      const start = "\u001b]633;NetcattyMcpCommandStart\u0007";
      const received = [];
      preload.api.onSessionData(sessionId, (data) => received.push(data));
      let send;
      if (transport === "port") {
        const port = createFakePort();
        preload.handlers.get("netcatty:terminal-output-port")?.({ ports: [port] }, { sessionId });
        send = (data, meta) => port.emit({ kind: "data", sessionId, data, meta });
      } else {
        send = (data, meta) => preload.handlers.get("netcatty:data")({}, { sessionId, data, meta });
      }
      send(`${marker}_I\n`, { mcpConptyCursorSync: true });
      assert.equal(received.join(""), sync);
      send(`hidden '${marker}_S'; accumulator\r\n`);
      assert.equal(received.join(""), sync, "quoted wrapper literals must not reanchor");
      send(`${marker}_S\r`);
      send(`\nOUTPUT\r\n${marker}_E:0\r\nPS C:\\test> `);
      assert.equal(received.join(""), sync + start + "OUTPUT\r\n" + sync + "PS C:\\test> ");
      send(`${marker}_R\n`);
      assert.equal(received.join("").endsWith(sync), true);
    } finally { preload.cleanup(); }
  });
}

test("cursor boundary opt-in is per session and absent from ordinary/remote output", () => {
  const preload = loadPreloadWithFakeElectron();
  try {
    const local = [], remote = [];
    preload.api.onSessionData("local", (data) => local.push(data));
    preload.api.onSessionData("remote", (data) => remote.push(data));
    const send = (sessionId, data, meta) => preload.handlers.get("netcatty:data")({}, { sessionId, data, meta });
    send("local", "__NCMCP_local___I\n", { mcpConptyCursorSync: true });
    send("remote", "__NCMCP_remote___I\n");
    send("remote", "__NCMCP_remote___S\r\nREMOTE\r\n");
    send("local", "__NCMCP_local___S\r\nLOCAL\r\n");
    assert.equal(remote.join(""), "REMOTE\r\n");
    assert.equal(local.join("").includes("NetcattyMcpCursorSync"), true);
  } finally { preload.cleanup(); }
});

for (const transport of ["legacy", "port"]) {
  test(`idle input releases an unterminated hidden history repaint via ${transport}`, async (t) => {
    const preload = loadPreloadWithFakeElectron();
    t.after(preload.cleanup);
    const sessionId = `history-reset-${transport}`;
    const received = [];
    const send = createMcpReplayHarness(preload, transport, sessionId, received);
    const meta = { mcpConptyCursorSync: true };
    send("__NCMCP_ready___I\n", meta);
    send("__NCMCP_ready___R\n", meta);
    send("\rPS C:\\> $__NCMCP_old='hidden'");
    await sleep(100); // The old flush deliberately retains drop-until-newline.
    const before = received.map((item) => item.data).join("");
    preload.api.writeToSession(sessionId, "\x1b[A");
    send("\rPS C:\\> Write-Output 'manual'");
    await sleep(50);
    const after = received.map((item) => item.data).join("").slice(before.length);
    assert.match(after, /Write-Output 'manual'/);
    assert.doesNotMatch(after, /__NCMCP_/);
    assert.equal(preload.sent.filter((item) => item.channel === "netcatty:write").length, 1);
  });

  test(`history skip retains direction and exact flow credit via ${transport}`, async (t) => {
    const preload = loadPreloadWithFakeElectron();
    t.after(preload.cleanup);
    const sessionId = `history-skip-${transport}`;
    const received = [];
    const send = createMcpReplayHarness(preload, transport, sessionId, received);
    const meta = { mcpConptyCursorSync: true };
    send("__NCMCP_ready___I\n", meta);
    send("__NCMCP_ready___R\n", meta);
    preload.api.writeToSession(sessionId, "\x1b[B");
    const first = "\rPS C:\\> $__NC";
    const second = "MCP_old='hidden'";
    send(first, { pluginPipelineIngressBytes: first.length });
    await sleep(45);
    send(second, { pluginPipelineIngressBytes: second.length });
    assert.equal(received.reduce((n, item) => n + (item.meta?.pluginPipelineIngressBytes || 0), 0), first.length + second.length);
    await sleep(45);
    assert.deepEqual(preload.sent.filter((item) => item.channel === "netcatty:write").map((item) => item.payload.data), ["\x1b[B", "\x1b[B"]);
    const manual = "\rPS C:\\> Write-Output 'manual'";
    send(manual, { pluginPipelineIngressBytes: manual.length });
    await sleep(50);
    assert.match(received.map((item) => item.data).join(""), /Write-Output 'manual'/);
    assert.doesNotMatch(received.map((item) => item.data).join(""), /__NCMCP_/);
    assert.equal(received.reduce((n, item) => n + (item.meta?.pluginPipelineIngressBytes || 0), 0), first.length + second.length + manual.length);
    assert.equal(received.filter((item) => item.data.includes("manual")).at(-1).meta.pluginPipelineIngressBytes, 0);
  });

  test(`interrupt and close cancel hidden-history retries via ${transport}`, async (t) => {
    const preload = loadPreloadWithFakeElectron();
    t.after(preload.cleanup);
    for (const action of ["interrupt", "close"]) {
      const sessionId = `history-cancel-${transport}-${action}`;
      const send = createMcpReplayHarness(preload, transport, sessionId, []);
      const meta = { mcpConptyCursorSync: true };
      send("__NCMCP_ready___I\n", meta);
      send("__NCMCP_ready___R\n", meta);
      preload.api.writeToSession(sessionId, "\x1b[A");
      send("__NCMCP_old");
      if (action === "interrupt") preload.api.interruptSession(sessionId);
      else await preload.api.closeSession(sessionId);
    }
    await sleep(70);
    assert.equal(preload.sent.filter((item) => item.channel === "netcatty:write").length, 2);
  });
}