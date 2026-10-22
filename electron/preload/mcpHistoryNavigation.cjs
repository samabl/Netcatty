"use strict";

const { mergeTerminalDataMeta } = require("./terminalDataMeta.cjs");
const { hasPluginPipelineIngressMarker } = require("./terminalDataBacklog.cjs");

const MARKER = "__NCMCP_";
const MAX_REDRAW_CHARS = 64 * 1024;

// Inspect text, not titles, clipboard/image payloads, or CSI parameters. An
// unfinished control string is excluded too, including split OSC terminators.
function stripNavigationControls(data) {
  return String(data ?? "")
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u009c|\u001b\\|$)/g, "")
    .replace(/(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u009c|\u001b\\|$)/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*$/, "")
    .replace(/\u001b[ -/]*[0-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function endsWithMarkerPrefix(text) {
  for (let length = 1; length < MARKER.length; length += 1) {
    if (text.endsWith(MARKER.slice(0, length))) return true;
  }
  return false;
}

function classifyHistoryInput(data) {
  if (data === "\u001b[A" || data === "\u001bOA") {
    return { kind: "arrow", direction: "up", retryData: data };
  }
  if (data === "\u001b[B" || data === "\u001bOB") {
    return { kind: "arrow", direction: "down", retryData: data };
  }
  // Win32 input: virtual key; scan code; Unicode; key-down; flags; repeat count.
  const packets = [...String(data).matchAll(/\u001b\[(\d+);(\d+);(\d+);([01]);(\d+);(\d+)_/g)];
  if (packets.length && packets.map((packet) => packet[0]).join("") === data) {
    const pressed = packets.filter((packet) => packet[4] === "1");
    if (!pressed.length) return { kind: "ignore" };
    const first = pressed[0];
    const vk = Number(first[1]);
    const arrow = (vk === 38 || vk === 40) && pressed.length === 1
      && packets.length <= 2 && Number(first[3]) === 0
      && packets.every((packet) => Number(packet[1]) === vk && !(Number(packet[5]) & 31));
    if (arrow) {
      const down = `\u001b[${vk};${first[2]};0;1;${first[5]};1_`;
      const up = `\u001b[${vk};${first[2]};0;0;${first[5]};1_`;
      return { kind: "arrow", direction: vk === 38 ? "up" : "down", retryData: down + up };
    }
    return { kind: "other", submit: pressed.some((packet) => Number(packet[1]) === 13 || [10, 13].includes(Number(packet[3]))) };
  }
  // Xterm protocol replies are not user actions and must not cancel a redraw.
  if (/^\u001b\[[?=>]?\d+(?:;\d+)*[Rcn]$/.test(data) || /^\u001b\]\d+;/.test(data)) {
    return { kind: "ignore" };
  }
  return { kind: "other", submit: /[\r\n\u0003]/.test(data) };
}

/**
 * Skip polluted local Windows history by sending ONLY another arrow. Never
 * send Enter, execute commands, mutate user history, or act on remote sessions.
 * New input, an agent job, a full-screen program, close, timeout, or retry limit
 * cancels the operation. Object identity protects against stale timer callbacks.
 */
function createMcpHistoryNavigation(options = {}) {
  const {
    sendInput = () => {}, resetIdleOutput = () => {}, deliverOutput = () => {},
    retainMetadata = () => {}, quietMs = 30, responseTimeoutMs = 600,
    maxNavigationMs = 8000, maxRetries = 128,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  } = options;
  const sessions = new Map();

  function clearTimers(nav) {
    for (const key of ["quietTimer", "responseTimer", "deadlineTimer"]) {
      if (nav[key] !== undefined) clearTimer(nav[key]);
      nav[key] = undefined;
    }
  }

  function takeBuffer(nav) {
    const buffered = { data: nav.data, meta: nav.meta };
    nav.data = "";
    nav.meta = undefined;
    return buffered;
  }

  function releaseBuffer(sessionId, nav, discard = false) {
    const buffered = takeBuffer(nav);
    const visible = stripNavigationControls(nav.inspection);
    if (discard || visible.includes(MARKER) || endsWithMarkerPrefix(visible)) {
      if (buffered.meta) retainMetadata(sessionId, buffered.meta);
    } else if (buffered.data || buffered.meta) {
      deliverOutput(sessionId, buffered.data, buffered.meta);
    }
  }

  function cancel(sessionId, discard = false) {
    const state = sessions.get(sessionId);
    const nav = state?.navigation;
    if (!nav) return;
    state.navigation = null;
    clearTimers(nav);
    releaseBuffer(sessionId, nav, discard);
  }

  function armResponseTimer(sessionId, state, nav) {
    if (nav.responseTimer !== undefined) clearTimer(nav.responseTimer);
    nav.responseTimer = setTimer(() => {
      if (state.navigation === nav) cancel(sessionId);
    }, responseTimeoutMs);
    nav.responseTimer?.unref?.();
  }

  function settleRedraw(sessionId, state, nav) {
    if (state.navigation !== nav) return;
    if (nav.quietTimer !== undefined) clearTimer(nav.quietTimer);
    nav.quietTimer = undefined;
    const visible = stripNavigationControls(nav.inspection);
    if (visible.includes(MARKER)) {
      releaseBuffer(sessionId, nav, true);
      if (state.agentMarker || state.alternateScreen || nav.retries >= maxRetries
        || now() >= nav.deadline) {
        cancel(sessionId, true);
        return;
      }
      nav.retries += 1;
      nav.inspection = "";
      resetIdleOutput(sessionId);
      armResponseTimer(sessionId, state, nav);
      sendInput(sessionId, nav.retryData);
    } else if (endsWithMarkerPrefix(visible)) {
      // Wait for a split prefix's suffix, or the bounded response timeout.
      return;
    } else if (!visible.trim()) {
      // Forward protocol bytes, but keep waiting for the actual input repaint.
      releaseBuffer(sessionId, nav);
    } else {
      cancel(sessionId);
    }
  }

  function observeTerminalState(sessionId, state, data) {
    const control = state.controlTail + data;
    for (const match of control.matchAll(/\u001b\[\?([0-9;]+)([hl])/g)) {
      if (match[1].split(";").some((mode) => ["47", "1047", "1049"].includes(mode))) {
        state.alternateScreen = match[2] === "h";
        state.atPrompt = false;
      }
    }
    state.controlTail = control.slice(-64);
    if (state.alternateScreen) cancel(sessionId);
    // After a manual submission, do not handle application arrows. Rearm only
    // on an unterminated Windows shell prompt, never newline-terminated output
    // that happens to look like one. Agent output cannot rearm navigation.
    state.promptTail = (state.promptTail + data).slice(-2048);
    const visible = stripNavigationControls(state.promptTail);
    if (!state.agentMarker && !state.alternateScreen
      && /(?:^|[\r\n])(?:PS [^\r\n]*>|[A-Za-z]:\\[^\r\n]*>)[ \t]*$/.test(visible)) {
      state.atPrompt = true;
    }
  }

  function filterOutput(sessionId, data, meta) {
    let state = sessions.get(sessionId);
    if (!state && meta?.mcpConptyCursorSync === true) {
      state = { agentMarker: null, atPrompt: false, alternateScreen: false,
        controlTail: "", promptTail: "", navigation: null };
      sessions.set(sessionId, state);
    }
    if (!state) return null;
    const control = meta?.mcpConptyCursorSync === true
      && /^\r?(__NCMCP_[A-Za-z0-9_]+)_([IQR])\r?\n?$/.exec(data);
    if (control) {
      cancel(sessionId);
      if (control[2] === "R") {
        if (!state.agentMarker || state.agentMarker === control[1]) {
          state.agentMarker = null;
          state.atPrompt = true;
        }
      } else {
        state.agentMarker = control[1];
        state.atPrompt = false;
      }
      state.promptTail = "";
      return null;
    }
    observeTerminalState(sessionId, state, data);
    const nav = state.navigation;
    if (!nav || !data) return null;
    if (nav.inspection.length + data.length > MAX_REDRAW_CHARS) {
      cancel(sessionId);
      return null;
    }
    nav.data += data;
    nav.inspection += data;
    // Both transports acknowledge original ingress NOW; delayed replay carries
    // explicit zero credit so fragments cannot be acknowledged twice.
    const replayMeta = hasPluginPipelineIngressMarker(meta)
      ? { ...meta, pluginPipelineIngressBytes: 0 } : meta;
    nav.meta = mergeTerminalDataMeta(nav.meta, replayMeta);
    if (nav.quietTimer !== undefined) clearTimer(nav.quietTimer);
    nav.quietTimer = setTimer(() => settleRedraw(sessionId, state, nav), quietMs);
    nav.quietTimer?.unref?.();
    return { data: "", meta: hasPluginPipelineIngressMarker(meta) ? meta : undefined };
  }

  function onInput(sessionId, data, inputOptions = {}) {
    const state = sessions.get(sessionId);
    if (!state) return;
    const input = classifyHistoryInput(String(data ?? ""));
    if (input.kind === "ignore") return;
    cancel(sessionId);
    state.promptTail = "";
    state.controlTail = "";
    const automatic = inputOptions.automated === true || inputOptions.pasteRequestId
      || inputOptions.sensitive === true;
    if (!automatic && !state.agentMarker && !state.alternateScreen) resetIdleOutput(sessionId);
    if (input.submit) state.atPrompt = false;
    if (automatic || input.kind !== "arrow" || state.agentMarker
      || state.alternateScreen || !state.atPrompt) return;
    const nav = { data: "", inspection: "", meta: undefined, retryData: input.retryData,
      retries: 0, deadline: now() + maxNavigationMs };
    state.navigation = nav;
    nav.deadlineTimer = setTimer(() => {
      if (state.navigation === nav) cancel(sessionId);
    }, maxNavigationMs);
    nav.deadlineTimer?.unref?.();
    armResponseTimer(sessionId, state, nav);
  }

  return {
    onInput, filterOutput,
    clearSession(sessionId) {
      const nav = sessions.get(sessionId)?.navigation;
      if (nav) clearTimers(nav);
      sessions.delete(sessionId);
    },
    flush(sessionId) {
      const state = sessions.get(sessionId);
      if (state?.navigation) settleRedraw(sessionId, state, state.navigation);
    },
    isAgentRunning: (sessionId) => Boolean(sessions.get(sessionId)?.agentMarker),
  };
}

module.exports = { createMcpHistoryNavigation, classifyHistoryInput, stripNavigationControls };