// OSC payloads are not terminal text. Keep them outside the MCP line filter,
// including when ConPTY splits the introducer or terminator between chunks.
// Only internal window titles are discarded; hyperlinks, images and other OSC
// protocols stream through without buffering their potentially large payloads.
const MAX_TITLE_CHARS = 64 * 1024;
const OSC_START = /\u001b\]|\u009d/g;
const OSC_END = /\u0007|\u009c|\u001b\\/g;

function createMcpOscFilter() {
  const sessions = new Map();

  function split(sessionId, input) {
    const data = String(input ?? "");
    const state = sessions.get(sessionId) || {
      mode: "text", buffer: "", escape: false,
    };
    const parts = [];
    const append = (kind, value) => {
      if (!value) return;
      const previous = parts[parts.length - 1];
      if (previous?.kind === kind) previous.data += value;
      else parts.push({ kind, data: value });
    };
    const reset = () => {
      state.mode = "text";
      state.buffer = "";
      state.escape = false;
    };
    let pos = 0;

    if (state.mode === "text" && state.escape && data) {
      state.escape = false;
      if (data[0] === "]") {
        state.mode = "header";
        state.buffer = "\u001b]";
        pos = 1;
      } else {
        append("text", "\u001b");
      }
    }

    while (pos < data.length) {
      if (state.mode === "text") {
        OSC_START.lastIndex = pos;
        const start = OSC_START.exec(data);
        if (!start) {
          const pendingEscape = data.endsWith("\u001b");
          append("text", data.slice(pos, pendingEscape ? -1 : undefined));
          state.escape = pendingEscape;
          break;
        }
        append("text", data.slice(pos, start.index));
        state.mode = "header";
        state.buffer = start[0];
        pos = start.index + start[0].length;
      } else if (state.mode === "header") {
        const char = data[pos++];
        state.buffer += char;
        if (char === ";") {
          const selector = state.buffer.slice(state.buffer.startsWith("\u001b") ? 2 : 1, -1);
          if (/^(?:0+|0*2)$/.test(selector)) {
            state.mode = "title";
          } else {
            append("osc", state.buffer);
            state.mode = "pass";
            state.buffer = "";
          }
          state.escape = false;
        } else if (char === "\u0007" || char === "\u009c" || (state.escape && char === "\\")) {
          append("osc", state.buffer);
          reset();
        } else {
          state.escape = char === "\u001b";
          // Invalid/non-numeric selectors must not accumulate unboundedly.
          if (state.buffer.length > 32) {
            append("osc", state.buffer);
            state.mode = "pass";
            state.buffer = "";
          }
        }
      } else {
        OSC_END.lastIndex = pos;
        const end = state.escape && data[pos] === "\\"
          ? { index: pos, 0: "\\" }
          : OSC_END.exec(data);
        const next = end ? end.index + end[0].length : data.length;
        const fragment = data.slice(pos, next);
        if (state.mode === "pass") {
          append("osc", fragment);
        } else if (state.mode === "title") {
          state.buffer += fragment;
          if (state.buffer.includes("__NCMCP_") || state.buffer.length > MAX_TITLE_CHARS) {
            state.buffer = "";
            state.mode = "drop";
          } else if (end) {
            append("osc", state.buffer);
          }
        }
        if (end) reset();
        else state.escape = fragment.endsWith("\u001b");
        pos = next;
      }
    }

    if (state.mode === "text" && !state.escape) sessions.delete(sessionId);
    else sessions.set(sessionId, state);
    return parts;
  }

  return {
    split,
    hasBuffered(sessionId) {
      const state = sessions.get(sessionId);
      return Boolean(state && (state.buffer || (state.mode === "text" && state.escape)));
    },
    clear(sessionId) { sessions.delete(sessionId); },
  };
}

module.exports = { createMcpOscFilter };
