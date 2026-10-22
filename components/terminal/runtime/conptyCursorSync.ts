import type { IDisposable, Terminal as XTerm } from "@xterm/xterm";

import { detectPrompt } from "../autocomplete/promptDetector";

import {
  createConptyCursorSyncState,
  mapConptyCursorRow,
  requestConptyCursorSync,
} from "../../../domain/conptyCursorSync";

// Preload-generated boundary, kept in the byte stream so it cannot overtake
// coalesced/queued xterm writes like an out-of-band IPC state callback could.
export const CONPTY_MCP_CURSOR_SYNC = "\x1b]633;NetcattyMcpCursorSync\x07";
export const CONPTY_MCP_COMMAND_START = "\x1b]633;NetcattyMcpCommandStart\x07";
const PAYLOAD = "NetcattyMcpCursorSync";
const COMMAND_PAYLOAD = "NetcattyMcpCommandStart";
type CsiParams = readonly (number | number[])[];
type InputParams = { params: number[]; length: number };
type CursorSyncTerminal = Pick<XTerm, "cols" | "rows" | "buffer" | "parser" | "onResize" | "onLineFeed"> & {
  _core?: {
    coreService?: { decPrivateModes?: { origin?: boolean } };
    _inputHandler?: {
      cursorPosition?: (params: InputParams) => boolean;
      linePosAbsolute?: (params: InputParams) => boolean;
    };
  };
};
const guards = new WeakMap<object, { reset: () => void; input: (data: string) => void }>();

export const resetConptyCursorSync = (term: object): void => {
  guards.get(term)?.reset();
};

/** Receives logical user input, never transport-only key-up or protocol replies. */
export const notifyConptyCursorSyncInput = (term: object, data: string): void => {
  guards.get(term)?.input(data);
};

/** Install only on first-party local Windows ConPTY sessions. */
export const installConptyCursorSync = (
  term: CursorSyncTerminal,
  enabled: boolean,
): IDisposable | null => {
  if (!enabled) return null;
  const input = term._core?._inputHandler;
  if (!input?.cursorPosition || !input.linePosAbsolute) return null;
  let state = createConptyCursorSyncState();
  let active = false;
  let commandRunning: "manual" | "agent" | null = null;
  let pendingSubmit = false;
  let savedPrompt = "";
  const reset = () => {
    state = createConptyCursorSyncState();
    active = false;
    commandRunning = null;
    pendingSubmit = false;
    savedPrompt = "";
  };
  const suspend = (kind: "manual" | "agent" = "manual") => {
    state = createConptyCursorSyncState();
    commandRunning = kind;
    pendingSubmit = false;
  };
  const atNormalScreen = () => term.buffer.active.type === "normal"
    && !term._core?.coreService?.decPrivateModes?.origin;
  const promptPrefix = () => {
    const buffer = term.buffer.active;
    return buffer.getLine(buffer.baseY + buffer.cursorY)
      ?.translateToString(false, 0, buffer.cursorX) ?? "";
  };
  const rearmAtShellPrompt = () => {
    // An explicit agent START owns the whole output phase until its next
    // boundary. Prompt-looking program output must not rebase native CSI.
    if (!active || commandRunning !== "manual" || !atNormalScreen()) return;
    const prefix = promptPrefix();
    const prompt = detectPrompt(term as XTerm);
    // An exact saved prefix also covers custom prompts without a terminator.
    if (!(savedPrompt && prefix === savedPrompt) && !(prompt.isAtPrompt && !prompt.userInput)) return;
    savedPrompt = prefix;
    commandRunning = null;
    state = requestConptyCursorSync();
  };
  const userInput = (data: string) => {
    if (!active || !data) return;
    if (!atNormalScreen()) { reset(); return; }
    // Xterm also sends device/status replies through onData. Those must never
    // turn a running application back into a shell-input repaint phase.
    const reply = data.startsWith("\x1b") && /^\[[?=>]?\d+(?:;\d+)*[Rcn]$/.test(data.slice(1));
    if (reply || data.startsWith("\x1b]")) return;
    rearmAtShellPrompt();
    if (!commandRunning && state.pending) savedPrompt = promptPrefix();
    if (data.includes("\r") || data.includes("\n")) {
      // CMD emits one last CUP before the submitted input's CRLF. Keep its
      // shell repaint compact, then suspend before any command output.
      if (!commandRunning) pendingSubmit = true;
      return;
    }
    if (data.includes("\x03")) {
      pendingSubmit = false;
      commandRunning = null;
      state = requestConptyCursorSync();
      return;
    }
  };
  const registration = { reset, input: userInput };
  guards.set(term, registration);
  const scalar = (params: CsiParams, index: number) => (
    typeof params[index] === "number" ? params[index] as number : 0
  );
  const move = (params: CsiParams, verticalOnly: boolean): boolean => {
    if (term.buffer.active.type !== "normal" || term._core?.coreService?.decPrivateModes?.origin) {
      reset();
      return false;
    }
    const nativeRow = (scalar(params, 0) || 1) - 1;
    const col = scalar(params, 1) || 1;
    // Literal home is screen-addressed output, not a PSReadLine current-input
    // repaint. Full-screen programs must retain native coordinate semantics.
    if (!verticalOnly && nativeRow === 0 && col === 1) {
      reset();
      return false;
    }
    // MCP clears pending input directly through the PTY, not through onData.
    // A completed manual prompt must re-arm before its Ctrl-C repaint arrives.
    rearmAtShellPrompt();
    if (commandRunning) return false;
    const mapped = mapConptyCursorRow(state, nativeRow, term.buffer.active.cursorY, term.rows);
    state = mapped.state;
    if (mapped.row === null) return false;
    const values = verticalOnly ? [mapped.row + 1] : [mapped.row + 1, col];
    // Reuse xterm's original handlers: column clamping, dirty-row tracking and
    // wrap-pending cleanup must remain identical to an ordinary CSI.
    const handler = verticalOnly ? input.linePosAbsolute! : input.cursorPosition!;
    return handler.call(input, { params: values, length: values.length });
  };
  const erases = (params: CsiParams): boolean => {
    if (scalar(params, 0) === 2 || scalar(params, 0) === 3) reset();
    return false;
  };
  const modes = (params: CsiParams): boolean => {
    if (params.some((param) => typeof param === "number" && [6, 47, 1047, 1049].includes(param))) reset();
    return false;
  };
  const disposables = [
    term.parser.registerOscHandler(633, (data) => {
      if (data !== PAYLOAD && data !== COMMAND_PAYLOAD) return false;
      if (!atNormalScreen()) { reset(); return true; }
      active = true;
      if (data === COMMAND_PAYLOAD) suspend("agent");
      else {
        pendingSubmit = false;
        commandRunning = null;
        state = requestConptyCursorSync();
      }
      return true;
    }),
    term.parser.registerCsiHandler({ final: "H" }, (params) => move(params, false)),
    term.parser.registerCsiHandler({ final: "f" }, (params) => move(params, false)),
    term.parser.registerCsiHandler({ final: "d" }, (params) => move(params, true)),
    term.parser.registerCsiHandler({ final: "J" }, erases),
    term.parser.registerCsiHandler({ prefix: "?", final: "J" }, erases),
    term.parser.registerCsiHandler({ prefix: "?", final: "h" }, modes),
    term.parser.registerCsiHandler({ prefix: "?", final: "l" }, modes),
    term.parser.registerCsiHandler({ final: "r" }, () => { reset(); return false; }),
    term.parser.registerCsiHandler({ intermediates: "!", final: "p" }, () => { reset(); return false; }),
    term.parser.registerEscHandler({ final: "c" }, () => { reset(); return false; }),
    term.onLineFeed(() => {
      if (pendingSubmit) suspend();
    }),
    term.onResize(() => {
      rearmAtShellPrompt();
      if (!commandRunning && (state.pending || state.nativeRow !== null)) state = requestConptyCursorSync();
    }),
  ];
  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
      if (guards.get(term) === registration) guards.delete(term);
      reset();
    },
  };
};
