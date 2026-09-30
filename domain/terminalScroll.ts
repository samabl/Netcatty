import type { TerminalSettings } from "./models";

type TerminalScrollTarget = {
  buffer: {
    active: {
      baseY: number;
      viewportY: number;
    };
  };
  scrollToBottom: () => void;
};

const hasPrintableTerminalInput = (data: string): boolean => {
  if (data.includes("\x1b")) {
    return false;
  }

  for (const char of data) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (codePoint >= 0x20 && codePoint !== 0x7f && codePoint !== 0x1b) {
      return true;
    }
  }
  return false;
};

export const shouldEnableNativeUserInputAutoScroll = (
  settings?: Partial<TerminalSettings> | null,
): boolean => settings?.scrollOnInput ?? true;

export const shouldScrollOnTerminalInput = (
  settings: Partial<TerminalSettings> | null | undefined,
  data: string,
): boolean => {
  const scrollOnInput = settings?.scrollOnInput ?? true;
  const scrollOnKeyPress = settings?.scrollOnKeyPress ?? false;

  if (!scrollOnInput && !scrollOnKeyPress) {
    return false;
  }

  // Ctrl+C (SIGINT) is handled by our urgent-interrupt path, which bypasses
  // xterm's native scrollOnUserInput. Map it to scroll-on-input so the default
  // "Scroll on input" setting returns the viewport to the bottom after the user
  // interrupts a scrolled-up stream (e.g. tail logs). #2287
  if (data === "\x03") {
    return scrollOnInput || scrollOnKeyPress;
  }

  return hasPrintableTerminalInput(data) ? scrollOnInput : scrollOnKeyPress;
};

export const shouldScrollOnTerminalOutput = (
  settings?: Partial<TerminalSettings> | null,
): boolean => settings?.scrollOnOutput ?? false;

export const shouldScrollOnTerminalPaste = (
  settings?: Partial<TerminalSettings> | null,
): boolean => settings?.scrollOnPaste ?? true;

export const isTerminalViewportAtBottom = (
  terminal: TerminalScrollTarget,
): boolean => {
  const { baseY, viewportY } = terminal.buffer.active;
  return viewportY >= baseY;
};

/**
 * Force the viewport down when the user is anywhere above the bottom.
 *
 * Input-driven scrolling is allowed to override the reading position (typing
 * returns to the prompt), so it uses this helper. Output must use
 * {@link followTerminalOutputIfAtBottom} instead, which never moves a reader.
 */
export const scrollTerminalToBottomIfNeeded = (
  terminal: TerminalScrollTarget,
): boolean => {
  if (isTerminalViewportAtBottom(terminal)) {
    return false;
  }

  terminal.scrollToBottom();
  return true;
};

/**
 * Output-driven auto-scroll ("Scroll on output").
 *
 * New output keeps a following viewport glued to the newest rows, but must
 * never pull a reader out of scrollback: while the viewport sits above the
 * bottom the visible rows stay put and fresh output is appended below, so past
 * output can be read without the view snapping back. Input keeps its own
 * behavior: typing still returns the viewport to the bottom, see
 * {@link scrollTerminalToBottomAfterInputIfEnabled}.
 *
 * The at-bottom call is a re-assert, not a move: xterm.js already follows new
 * lines there, so it resolves to a zero-row scroll that only clears a stale
 * user-scroll flag / DOM offset left behind by a burst (#2291).
 */
export const followTerminalOutputIfAtBottom = (
  terminal: TerminalScrollTarget,
): boolean => {
  if (!isTerminalViewportAtBottom(terminal)) {
    return false;
  }

  terminal.scrollToBottom();
  return true;
};

export const scrollTerminalToBottomAfterInputIfEnabled = (
  terminal: TerminalScrollTarget,
  settings: Partial<TerminalSettings> | null | undefined,
  data: string,
): boolean => {
  if (!shouldScrollOnTerminalInput(settings, data)) {
    return false;
  }

  return scrollTerminalToBottomIfNeeded(terminal);
};
