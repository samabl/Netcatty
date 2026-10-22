"use strict";
const assert = require("node:assert/strict");
const test = require("node:test");
const { createMcpHistoryNavigation, classifyHistoryInput, stripNavigationControls } = require("./mcpHistoryNavigation.cjs");

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const winKey = (vk, scan, down = 1, flags = 256, repeat = 1) => `\x1b[${vk};${scan};0;${down};${flags};${repeat}_`;
const trusted = { mcpConptyCursorSync: true };

function harness(options = {}) {
  let time = 0;
  let id = 0;
  const timers = new Map();
  const sent = [], delivered = [], retained = [], resets = [];
  const nav = createMcpHistoryNavigation({
    quietMs: 10, responseTimeoutMs: 80, maxNavigationMs: 250, maxRetries: 3,
    now: () => time,
    setTimer(fn, delay) { const key = ++id; timers.set(key, { fn, at: time + delay }); return key; },
    clearTimer(key) { timers.delete(key); },
    sendInput: (sessionId, data) => sent.push({ sessionId, data }),
    deliverOutput: (sessionId, data, meta) => delivered.push({ sessionId, data, meta }),
    retainMetadata: (sessionId, meta) => retained.push({ sessionId, meta }),
    resetIdleOutput: (sessionId) => resets.push(sessionId),
    ...options,
  });
  const tick = (ms) => {
    const target = time + ms;
    for (;;) {
      const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      time = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
    }
    time = target;
  };
  const ready = (sessionId = "local") => {
    nav.filterOutput(sessionId, "__NCMCP_job___I\n", trusted);
    nav.filterOutput(sessionId, "__NCMCP_job___R\n", trusted);
  };
  ready();
  return { nav, tick, ready, sent, delivered, retained, resets, timers };
}

test("recognizes unmodified ANSI/application and Win32 history arrows only", () => {
  for (const key of [UP, "\x1bOA", DOWN, "\x1bOB", winKey(38, 72), winKey(40, 80) + winKey(40, 80, 0)]) {
    assert.equal(classifyHistoryInput(key).kind, "arrow");
  }
  const repeated = classifyHistoryInput(winKey(38, 72, 1, 256, 8));
  assert.equal(repeated.retryData, winKey(38, 72) + winKey(38, 72, 0));
  for (const key of ["\x1b[1;2A", UP + DOWN, UP + "x", winKey(38, 72, 1, 272)]) {
    assert.equal(classifyHistoryInput(key).kind, "other");
  }
  assert.equal(classifyHistoryInput(winKey(38, 72, 0)).kind, "ignore");
  assert.equal(classifyHistoryInput("\x1b[4;1R").kind, "ignore");
  assert.equal(classifyHistoryInput("\x1b[13;28;13;1;256;1_").submit, true);
});

test("control payloads including incomplete OSC and C1 sequences are not history text", () => {
  assert.equal(stripNavigationControls("\x1b]52;c;__NCMCP_payload\x07\x1b[3;1Hsafe"), "safe");
  assert.equal(stripNavigationControls("\x1b]0;__NCMCP_unfinished"), "");
  assert.equal(stripNavigationControls("\x1bP__NCMCP_dcs\x1b\\safe"), "safe");
  assert.equal(stripNavigationControls("\x9d0;__NCMCP_title\x9c\x9b2Ksafe"), "safe");
});

test("Up skips an internal redraw without Enter and releases the next legitimate command", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  assert.deepEqual(h.nav.filterOutput("local", "\rPS C:\\> $__NCMCP_old='x'"), { data: "", meta: undefined });
  h.tick(10);
  assert.deepEqual(h.sent, [{ sessionId: "local", data: UP }]);
  h.nav.filterOutput("local", "\rPS C:\\> Write-Output 'manual'");
  h.tick(10);
  assert.equal(h.delivered.at(-1).data, "\rPS C:\\> Write-Output 'manual'");
  h.tick(500);
  assert.equal(h.sent.length, 1);
  assert.ok(h.resets.length >= 2);
});

test("Down preserves direction when crossing internal history", () => {
  const h = harness();
  h.nav.onInput("local", DOWN);
  h.nav.filterOutput("local", "\rC:\\>set \"__NCMCP_old=0\"");
  h.tick(10);
  assert.equal(h.sent[0].data, DOWN);
});

test("slow split marker is held, then skipped once, with ingress credit acknowledged exactly once", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  const first = h.nav.filterOutput("local", "\rPS C:\\> $__NC", { pluginPipelineIngressBytes: 5 });
  assert.equal(first.meta.pluginPipelineIngressBytes, 5);
  h.tick(35);
  assert.equal(h.sent.length, 0);
  assert.equal(h.delivered.length, 0);
  const second = h.nav.filterOutput("local", "MCP_hidden", { pluginPipelineIngressBytes: 7, droppedOutputMayAffectTerminalState: true });
  assert.equal(second.meta.pluginPipelineIngressBytes, 7);
  h.tick(10);
  assert.equal(h.sent.length, 1);
  assert.equal(h.retained[0].meta.pluginPipelineIngressBytes, 0);
  assert.equal(h.retained[0].meta.droppedOutputMayAffectTerminalState, true);
  h.nav.filterOutput("local", "\rPS C:\\> manual", { pluginPipelineIngressBytes: 4 });
  h.tick(10);
  assert.equal(h.delivered[0].meta.pluginPipelineIngressBytes, 0);
});

test("a split OSC payload never triggers an extra arrow, even across quiet periods", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  h.nav.filterOutput("local", "\x1b]52;c;");
  h.tick(15);
  h.nav.filterOutput("local", "__NCMCP_payload");
  h.tick(15);
  h.nav.filterOutput("local", "\x07\rPS C:\\> manual");
  h.tick(15);
  assert.equal(h.sent.length, 0);
  assert.equal(h.delivered.map((item) => item.data).join(""), "\x1b]52;c;__NCMCP_payload\x07\rPS C:\\> manual");
});

test("typing or interruption cancels pending retries without executing the hidden entry", () => {
  for (const input of ["x", "\r", "\x03", "\x1b[1;2A"]) {
    const h = harness();
    h.nav.onInput("local", UP);
    h.nav.filterOutput("local", "\rPS C:\\> $__NCMCP_old");
    h.nav.onInput("local", input);
    h.tick(500);
    assert.equal(h.sent.length, 0, JSON.stringify(input));
    assert.equal(h.delivered.length, 0);
  }
});

test("a new arrow invalidates stale callbacks and changes the retry direction", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  h.nav.filterOutput("local", "__NCMCP_old");
  h.tick(5);
  h.nav.onInput("local", DOWN);
  h.nav.filterOutput("local", "__NCMCP_other");
  h.tick(10);
  assert.deepEqual(h.sent, [{ sessionId: "local", data: DOWN }]);
});

test("Win32 release-only input and protocol replies do not cancel navigation", () => {
  const h = harness();
  h.nav.onInput("local", winKey(38, 72));
  h.nav.filterOutput("local", "__NCMCP_old");
  h.nav.onInput("local", winKey(38, 72, 0));
  h.nav.onInput("local", "\x1b[8;1R");
  h.tick(10);
  assert.equal(h.sent[0].data, winKey(38, 72) + winKey(38, 72, 0));
});

test("agent START does not make its running program eligible for history navigation", () => {
  const h = harness();
  h.nav.filterOutput("local", "__NCMCP_new___I\n", trusted);
  h.nav.filterOutput("local", "__NCMCP_new___S\r\nPS C:\\>");
  h.nav.onInput("local", UP);
  assert.equal(h.nav.filterOutput("local", "__NCMCP_program"), null);
  h.nav.filterOutput("local", "__NCMCP_old___R\n", trusted);
  assert.equal(h.nav.isAgentRunning("local"), true);
  h.nav.filterOutput("local", "__NCMCP_new___R\n");
  assert.equal(h.nav.isAgentRunning("local"), true, "untrusted output cannot end the job");
  h.tick(500);
  assert.equal(h.sent.length, 0);
  assert.equal(h.resets.length, 0);
});

test("new agent prime cancels an already pending history retry", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  h.nav.filterOutput("local", "__NCMCP_old");
  h.nav.filterOutput("local", "__NCMCP_new___I\n", trusted);
  h.tick(500);
  assert.equal(h.sent.length, 0);
});

test("manual programs stay excluded until a real unterminated Windows prompt returns", () => {
  for (const enter of ["\r", "\x1b[13;28;13;1;256;1_"]) {
    const h = harness();
    h.nav.onInput("local", enter);
    h.nav.filterOutput("local", "PS C:\\>\r\n");
    h.nav.onInput("local", UP);
    assert.equal(h.nav.filterOutput("local", "__NCMCP_program"), null);
    h.nav.filterOutput("local", "\r\nPS C:\\> ");
    h.nav.onInput("local", UP);
    h.nav.filterOutput("local", "__NCMCP_old");
    h.tick(10);
    assert.equal(h.sent.length, 1);
  }
});

test("alternate-screen programs cancel and exclude navigation, including split mode sequences", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  h.nav.filterOutput("local", "\x1b[?10");
  h.nav.filterOutput("local", "49h");
  h.nav.onInput("local", UP);
  assert.equal(h.nav.filterOutput("local", "__NCMCP_program"), null);
  h.tick(500);
  assert.equal(h.sent.length, 0);
});

test("remote, automated, pasted, sensitive, and mixed input never skip history", () => {
  const h = harness();
  h.nav.onInput("remote", UP);
  assert.equal(h.nav.filterOutput("remote", "__NCMCP_old"), null);
  for (const options of [{ automated: true }, { pasteRequestId: "paste" }, { sensitive: true }]) {
    h.nav.onInput("local", UP, options);
    assert.equal(h.nav.filterOutput("local", "__NCMCP_old"), null);
  }
  h.tick(500);
  assert.equal(h.sent.length, 0);
});

test("navigation is bounded by retry count, response timeout, and redraw storage", () => {
  const h = harness();
  h.nav.onInput("local", UP);
  for (let n = 0; n < 5; n += 1) {
    h.nav.filterOutput("local", `__NCMCP_${n}`);
    h.tick(10);
  }
  assert.equal(h.sent.length, 3);
  h.nav.onInput("local", DOWN);
  h.tick(90);
  assert.equal(h.nav.filterOutput("local", "__NCMCP_late"), null);
  h.nav.onInput("local", DOWN);
  assert.equal(h.nav.filterOutput("local", "x".repeat(65537)), null);
  h.tick(500);
  assert.equal(h.sent.length, 3);
});

test("closing one session removes pending work without retaining its metadata or touching another", () => {
  const h = harness();
  h.ready("other");
  h.nav.onInput("local", UP);
  h.nav.onInput("other", DOWN);
  h.nav.filterOutput("local", "__NCMCP_old", { pluginPipelineIngressBytes: 12 });
  h.nav.filterOutput("other", "__NCMCP_other");
  h.nav.clearSession("local");
  h.tick(10);
  assert.deepEqual(h.sent, [{ sessionId: "other", data: DOWN }]);
  assert.equal(h.retained.length, 0);
  assert.equal(h.nav.filterOutput("local", "__NCMCP_late"), null);
});