import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createRequire } from "node:module";
import type { Terminal as XTerm } from "@xterm/xterm";

const { Terminal } = createRequire(import.meta.url)("@xterm/xterm") as typeof import("@xterm/xterm");

import {
  CONPTY_MCP_CURSOR_SYNC as SYNC,
  CONPTY_MCP_COMMAND_START as START,
  installConptyCursorSync,
  notifyConptyCursorSyncInput as input,
  resetConptyCursorSync,
} from "./conptyCursorSync";

const write = (term: XTerm, data: string): Promise<void> => new Promise((done) => term.write(data, done));
const lines = (term: XTerm) => Array.from({ length: term.rows }, (_, row) => (
  term.buffer.active.getLine(term.buffer.active.baseY + row)?.translateToString(true) ?? ""
));
const create = (t: TestContext, enabled = true) => {
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 48 });
  const guard = installConptyCursorSync(term, enabled);
  t.after(() => { guard?.dispose(); term.dispose(); });
  return term;
};
const initial = "PS C:/test> Write-Output 'FIRST'\r\nFIRST\r\nPS C:/test> ";

test("real xterm: MCP followed by keyboard repaint stays compact and preserves prompt", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  await write(term, "\x1b[48;13HWrite-Output 'MANUAL'\r\nMANUAL\r\nPS C:/test> ");
  assert.deepEqual(lines(term).slice(0, 5), [
    "PS C:/test> Write-Output 'FIRST'", "FIRST",
    "PS C:/test> Write-Output 'MANUAL'", "MANUAL", "PS C:/test> ",
  ]);
  assert.equal(term.buffer.active.cursorY, 4);
});

test("real xterm: consecutive agent boundaries survive coalesced writes and split OSC", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC.slice(0, 6));
  await write(term, SYNC.slice(6) + "\x1b[48;13H^C\r\nPS C:/test> NEXT\r\n" + SYNC + "NEXT\r\n" + SYNC + "PS C:/test> ");
  await write(term, "\x1b[48;13HMANUAL\r\nOK\r\nPS C:/test> ");
  assert.equal(term.buffer.active.cursorY, 7);
  assert.deepEqual(lines(term).slice(0, 8), [
    "PS C:/test> Write-Output 'FIRST'", "FIRST", "PS C:/test> ^C",
    "PS C:/test> NEXT", "NEXT", "PS C:/test> MANUAL", "OK", "PS C:/test> ",
  ]);
});

test("real xterm: wrapped manual input repaints without corrupting earlier output", async (t) => {
  const term = create(t);
  const text = "'" + "x".repeat(100) + "'";
  await write(term, initial + SYNC + "\x1b[48;13H" + text);
  await write(term, "\x1b[48;35H\x1b[47;13H" + text + "\x1b[48;35H\r\nWRAPPED\r\nPS C:/test> ");
  assert.deepEqual(lines(term).slice(0, 3), [
    "PS C:/test> Write-Output 'FIRST'", "FIRST", "PS C:/test> " + text.slice(0, 68),
  ]);
  assert.equal(lines(term)[4], "WRAPPED");
  assert.equal(term.buffer.active.cursorY, 5);
});

test("real xterm: HVP and VPA use the same mapping and preserve VPA column", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + "\x1b[48;13fF\x1b[48dV");
  assert.equal(lines(term)[2], "PS C:/test> FV");
  assert.equal(term.buffer.active.cursorY, 2);
  assert.equal(term.buffer.active.cursorX, 14);
});

test("real xterm: heavy visible output converges and retains scrollback", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + "\x1b[48;13HMANUAL\r\n");
  await write(term, Array.from({ length: 120 }, (_, i) => `LINE_${i}\r\n`).join("") + "PS C:/test> ");
  const base = term.buffer.active.baseY;
  await write(term, "\x1b[48;13HAFTER");
  assert.ok(base > 0);
  assert.equal(term.buffer.active.baseY, base);
  assert.equal(lines(term)[47], "PS C:/test> AFTER");
  assert.equal(term.buffer.active.getLine(0)?.translateToString(true), "PS C:/test> Write-Output 'FIRST'");
});

for (const clear of ["\x1b[2J", "\x1b[3J", "\x1b[?2J", "\x1bc", "\x1b[!p", "\x1b[r"]) {
  test(`real xterm: reset/clear ${JSON.stringify(clear)} removes stale mapping`, async (t) => {
    const term = create(t);
    await write(term, initial + SYNC + "\x1b[48;13HX" + clear + "\x1b[20;1HSCREEN");
    assert.equal(term.buffer.active.cursorY, 19);
    assert.equal(lines(term)[19], "SCREEN");
  });
}

test("real xterm: alternate-screen programs retain native addressing, then rearm on next boundary", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + "\x1b[48;13HX\x1b[?1049h" + SYNC + "\x1b[20;1HTUI");
  assert.equal(term.buffer.active.type, "alternate");
  assert.equal(lines(term)[19], "TUI");
  await write(term, "\x1b[?1049l" + SYNC + "\x1b[48;14HAFTER");
  assert.equal(term.buffer.active.type, "normal");
  assert.equal(lines(term)[2], "PS C:/test> XAFTER");
});

test("real xterm: home and origin mode do not translate screen-addressed output", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + "\x1b[HHOME\x1b[20;1HSCREEN");
  assert.equal(lines(term)[0].startsWith("HOME"), true);
  assert.equal(lines(term)[19], "SCREEN");
  await write(term, SYNC + "\x1b[10;30r\x1b[?6h\x1b[2;1HORIGIN");
  assert.equal(lines(term)[10], "ORIGIN");
});

test("real xterm: resize reanchors the next input repaint", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + "\x1b[48;13HX");
  term.resize(100, 30);
  await write(term, "\x1b[30;14HAFTER");
  assert.equal(lines(term)[2], "PS C:/test> XAFTER");
});

test("real xterm: explicit frontend clear resets, unknown OSC does not arm", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  resetConptyCursorSync(term);
  await write(term, "\x1b]633;NotNetcatty\x07\x1b[20;1HSCREEN");
  assert.equal(lines(term)[19], "SCREEN");
});

test("real xterm: nonlocal/non-ConPTY sessions and disposed guards are untouched", async (t) => {
  const term = create(t, false);
  await write(term, initial + SYNC + "\x1b[48;13HNATIVE");
  assert.equal(term.buffer.active.cursorY, 47);
  const guard = installConptyCursorSync(term, true)!;
  await write(term, SYNC);
  guard.dispose();
  await write(term, "\x1b[20;1HSCREEN");
  assert.equal(lines(term)[19], "SCREEN");
});


for (const csi of ["\x1b[10;1H", "\x1b[10;1f", "\x1b[10d"]) {
  test("real xterm: agent command output preserves native " + JSON.stringify(csi), async (t) => {
    const term = create(t);
    await write(term, initial + SYNC + "\x1b[48;13Hagent\r\n" + START.slice(0, 8));
    await write(term, START.slice(8) + csi + "SCREEN_ADDRESS_TARGET" + SYNC);
    assert.equal(lines(term)[9].includes("SCREEN_ADDRESS_TARGET"), true);
    assert.equal(term.buffer.active.cursorY, 9);
  });
}

test("real xterm: manual Enter suspends mapping for normal-screen command output", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "n");
  await write(term, "\x1b[48;13Hnode address-test");
  input(term, "\r");
  await write(term, "\r\n\x1b[10;1HSCREEN_ADDRESS_TARGET\r\nPS C:/test> ");
  assert.equal(lines(term)[9], "SCREEN_ADDRESS_TARGET");
  input(term, "e");
  await write(term, "\x1b[48;13HECHO\r\nAFTER\r\nPS C:/test> ");
  assert.equal(lines(term)[10], "PS C:/test> ECHO");
  assert.equal(term.buffer.active.cursorY, 12);
});

test("real xterm: device replies and running-program input never rearm shell mapping", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "p");
  await write(term, "\x1b[48;13Hprogram");
  input(term, "\r");
  await write(term, "\r\n\x1b[10;1HCHOOSE_AN_ITEM");
  for (const data of ["x", "\x1b[A", "\x1b[10;15R", "\x1b[?1;2c", "\x1b[0n"]) {
    input(term, data);
    await write(term, "\x1b[6;1HNATIVE_PROGRAM");
    assert.equal(lines(term)[5], "NATIVE_PROGRAM");
    assert.equal(term.buffer.active.cursorY, 5);
  }
});

test("real xterm: a custom prompt can rearm after a manually submitted command", async (t) => {
  const term = create(t);
  const prompt = "NC_INPUT ";
  const native = "\x1b[48;" + (prompt.length + 1) + "H";
  await write(term, prompt + "FIRST\r\nFIRST\r\n" + prompt + SYNC);
  input(term, "e");
  await write(term, native + "ECHO");
  input(term, "\r");
  await write(term, "\r\nSECOND\r\n" + prompt);
  input(term, "e");
  await write(term, native + "AGAIN");
  assert.equal(lines(term)[4], prompt + "AGAIN");
  assert.equal(term.buffer.active.cursorY, 4);
});

test("real xterm: alternate-screen input cannot restore a previous shell anchor", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "t");
  await write(term, "\x1b[48;13Htui");
  input(term, "\r");
  await write(term, "\x1b[?1049h\x1b[10;1HTUI");
  input(term, "x");
  await write(term, "\x1b[20;1HNATIVE");
  assert.equal(lines(term)[19], "NATIVE");
  await write(term, "\x1b[?1049l" + SYNC + "\x1b[48;16HBACK");
  assert.equal(lines(term)[2], "PS C:/test> tuiBACK");
});



test("real xterm: Enter preserves CMD's final input repaint before suspending", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "e");
  await write(term, "\x1b[48;13HECHO");
  input(term, "\r");
  await write(term, "\x1b[48;17H\r\nOUTPUT\r\nPS C:/test> ");
  assert.equal(lines(term)[2], "PS C:/test> ECHO");
  assert.equal(lines(term)[3], "OUTPUT");
  assert.equal(term.buffer.active.cursorY, 4);
});


test("real xterm: direct agent input reset after manual completion keeps the full prompt", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "e");
  await write(term, "\x1b[48;13HECHO");
  input(term, "\r");
  await write(term, "\r\nOUTPUT\r\nPS C:/test> ");
  await write(term, "\x1b[48;13H^C\r\nPS C:/test> NEXT\r\n" + SYNC + START + "NEXT\r\n" + SYNC + "PS C:/test> ");
  assert.equal(lines(term)[4], "PS C:/test> ^C");
  assert.equal(lines(term)[5], "PS C:/test> NEXT");
  assert.equal(term.buffer.active.cursorY, 7);
});

test("real xterm: idle manual prompt rearms on resize before an agent reset", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "e");
  await write(term, "\x1b[48;13HECHO");
  input(term, "\r");
  await write(term, "\r\nOUTPUT\r\nPS C:/test> ");
  term.resize(100, 30);
  await write(term, "\x1b[30;13H^C\r\nPS C:/test> ");
  assert.equal(lines(term)[4], "PS C:/test> ^C");
  assert.equal(term.buffer.active.cursorY, 5);
});

test("real xterm: resizing a running normal-screen program does not rearm mapping", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + START + "RUNNING");
  term.resize(100, 30);
  await write(term, "\x1b[20;1HSCREEN_ADDRESS_TARGET");
  assert.equal(lines(term)[19], "SCREEN_ADDRESS_TARGET");
  assert.equal(term.buffer.active.cursorY, 19);
});


test("real xterm: agent START cannot rearm from a prompt-looking output line", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC + START);
  term.resize(100, 30);
  await write(term, "\x1b[10;1HSCREEN_ADDRESS_TARGET");
  assert.equal(lines(term)[9], "SCREEN_ADDRESS_TARGET");
  assert.equal(term.buffer.active.cursorY, 9);
});

for (const resize of [false, true]) {
  test("real xterm: direct agent reset rearms a custom manual prompt" + (resize ? " after resize" : ""), async (t) => {
    const term = create(t);
    const prompt = "NC_INPUT ";
    await write(term, prompt + SYNC);
    input(term, "e");
    await write(term, "\x1b[48;10HECHO");
    input(term, "\r");
    await write(term, "\r\nOUTPUT\r\n" + prompt);
    if (resize) term.resize(100, 30);
    await write(term, (resize ? "\x1b[30;10H" : "\x1b[48;10H") + "^C\r\n" + prompt);
    assert.equal(lines(term)[2], prompt + "^C");
    assert.equal(lines(term)[3], prompt);
    assert.equal(term.buffer.active.cursorY, 3);
  });
}

test("real xterm: a submitted paste after manual completion suspends before program output", async (t) => {
  const term = create(t);
  await write(term, initial + SYNC);
  input(term, "e");
  await write(term, "\x1b[48;13HECHO");
  input(term, "\r");
  await write(term, "\r\nOUTPUT\r\nPS C:/test> ");
  input(term, "node address\r");
  await write(term, "\x1b[48;13Hnode address\r\n\x1b[10;1HSCREEN_ADDRESS_TARGET");
  assert.equal(lines(term)[4], "PS C:/test> node address");
  assert.equal(lines(term)[9], "SCREEN_ADDRESS_TARGET");
  assert.equal(term.buffer.active.cursorY, 9);
});
