"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync, unlinkSync } = require("node:fs");
const { join, dirname, delimiter } = require("node:path");
const { spawnSync } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const { release } = require("node:os");
const { execViaPty } = require("./ptyExec.cjs");
const { powerShellHistoryGuardStatements } = require("./ptyExecHelpers.cjs");
const { getTempFilePath } = require("../tempDirBridge.cjs");
const { loadPreloadWithFakeElectron } = require("../../preload/fixtures/loadPreloadWithFakeElectron.cjs");
const { classifyHistoryInput } = require("../../preload/mcpHistoryNavigation.cjs");

const windows = process.platform === "win32";
const windowsRoot = process.env.SystemRoot || "C:\\Windows";
const ps5 = join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const ps7 = join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
const bundledModule = [
  join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "Modules", "PSReadLine", "PSReadLine.psd1"),
  join(process.env.ProgramFiles || "C:\\Program Files", "WindowsPowerShell", "Modules", "PSReadline", "2.0.0", "PSReadline.psd1"),
].find((path) => existsSync(path)) || "PSReadLine";
const powerShells = [
  { label: "PS5 legacy PSReadLine", executable: ps5, module: bundledModule },
  { label: "PS5 current PSReadLine", executable: ps5, module: "PSReadLine" },
  { label: "PS7", executable: ps7, module: "PSReadLine" },
];
const quotePS = (text) => String(text).replaceAll("'", "''");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const shell of powerShells) {
  test(`PowerShell history guard preserves privacy and handler identity in ${shell.label}`, {
    skip: !windows || !existsSync(shell.executable) || (shell.module !== "PSReadLine" && !existsSync(shell.module)),
    timeout: 20_000,
  }, () => {
    const guard = powerShellHistoryGuardStatements().join("\n");
    const script = `$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Import-Module '${quotePS(shell.module)}'
Set-StrictMode -Version Latest
$previous=(Get-PSReadLineOption).AddToHistoryHandler
$expected=if($previous){$previous.Invoke('NETCATTY_SAFE_COMMAND')}else{$true}
${guard}
$first=(Get-PSReadLineOption).AddToHistoryHandler
$safe=$first.Invoke('NETCATTY_SAFE_COMMAND')
$hidden=$first.Invoke('$__NCMCP_probe=1')
${guard}
$same=[object]::ReferenceEquals($first,(Get-PSReadLineOption).AddToHistoryHandler)
Set-PSReadLineOption -AddToHistoryHandler {param($l) $l -ne 'NETCATTY_PRIVATE_COMMAND'}
${guard}
$replacement=(Get-PSReadLineOption).AddToHistoryHandler
$result=[ordered]@{
version=(Get-Module PSReadLine).Version.ToString()
expected=[string]$expected
safe=[string]$safe
hidden=[string]$hidden
idempotent=$same
private=[string]$replacement.Invoke('NETCATTY_PRIVATE_COMMAND')
fresh=[string]$replacement.Invoke('NETCATTY_SAFE_COMMAND')
hiddenAgain=[string]$replacement.Invoke('$__NCMCP_probe=2')
}
$memoryType='Microsoft.PowerShell.AddToHistoryOption' -as [type]
if($memoryType){
Set-PSReadLineOption -AddToHistoryHandler {param($l) [Microsoft.PowerShell.AddToHistoryOption]::MemoryOnly}
${guard}
$result.memoryOnly=[string]((Get-PSReadLineOption).AddToHistoryHandler.Invoke('NETCATTY_PRIVATE_COMMAND'))
}
Remove-Module PSReadLine
$PSModuleAutoLoadingPreference='None'
${guard}
$result.missingModuleSafe=$true
$result|ConvertTo-Json -Compress`;
    const process = spawnSync(shell.executable, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    assert.ifError(process.error);
    assert.equal(process.status, 0, process.stderr);
    const result = JSON.parse(process.stdout.trim());
    assert.equal(result.safe, result.expected);
    assert.equal(result.hidden, "False");
    assert.equal(result.idempotent, true);
    assert.equal(result.private, "False");
    assert.equal(result.fresh, "True");
    assert.equal(result.hiddenAgain, "False");
    assert.equal(result.missingModuleSafe, true);
    if (result.memoryOnly !== undefined) assert.equal(result.memoryOnly, "MemoryOnly");
  });
}

const nativeShells = [
  { label: "CMD", kind: "cmd", executable: join(windowsRoot, "System32", "cmd.exe") },
  ...powerShells,
].map((shell) => ({ kind: "powershell", ...shell }));
const win32Arrow = (direction) => {
  const [key, scan] = direction === "up" ? [38, 72] : [40, 80];
  return `\x1b[${key};${scan};0;1;256;1_\x1b[${key};${scan};0;0;256;1_`;
};

// Own the PTY, history path, xterm and fake IPC instance. Never connect these
// tests to a user terminal, run a profile, or read/write the user's history.
async function createNativeHarness(shell, t) {
  const ptyModule = require("node-pty");
  const { Terminal } = require("@xterm/xterm");
  const { installConptyCursorSync, notifyConptyCursorSyncInput } = require("../../../components/terminal/runtime/conptyCursorSync.ts");
  const sessionId = `native-history-${randomUUID()}`;
  const historyPath = shell.kind === "powershell" ? getTempFilePath(`${sessionId}.history`) : null;
  const args = shell.kind === "cmd" ? ["/d"] : [
    "-NoLogo", "-NoProfile", "-NoExit", "-Command",
    `Import-Module '${quotePS(shell.module)}'; Set-PSReadLineOption -HistorySavePath '${quotePS(historyPath)}' -HistorySaveStyle SaveNothing`,
  ];
  const env = { ...process.env, TERM: "xterm-256color", PROMPT: "$P$G" };
  delete env.NC_TEST_PENDING;
  if (shell.kind === "powershell") {
    // The console host imports PSReadLine before -Command. Restrict discovery
    // so the legacy fixture is not mixed with a newer inherited PS7 module;
    // otherwise its options/history and the active editor are different.
    const systemModules = join(dirname(shell.executable), "Modules");
    const moduleRoot = shell.module === "PSReadLine"
      ? join(dirname(ps7), "Modules")
      : shell.module.includes("2.0.0") ? dirname(dirname(dirname(shell.module))) : dirname(dirname(shell.module));
    env.PSModulePath = [...new Set([moduleRoot, systemModules])].join(delimiter);
  }
  const pty = ptyModule.spawn(shell.executable, args, {
    cols: 100, rows: 30, cwd: join(__dirname, "../../.."), useConpty: true, useConptyDll: true,
    env,
  });
  const terminalOptions = {
    cols: 100, rows: 30, scrollback: 1000, allowProposedApi: true,
    windowsPty: { backend: "conpty", buildNumber: Number(release().split(".").at(-1)) || 26100 },
  };
  const terminal = new Terminal(terminalOptions);
  const rawTerminal = new Terminal(terminalOptions);
  const cursorSync = installConptyCursorSync(terminal, true);
  const stream = new EventEmitter();
  stream.write = (data) => pty.write(data);
  let raw = "";
  let closed = false;
  const preload = loadPreloadWithFakeElectron({ onSend(channel, payload) {
    if (closed || payload?.sessionId !== sessionId) return;
    if (channel === "netcatty:write") pty.write(payload.data);
    else if (channel === "netcatty:interrupt" && !payload.cancelPendingWritesOnly) pty.write("\x03");
  } });
  const emit = (data, meta) => preload.handlers.get("netcatty:data")({}, { sessionId, data, meta });
  preload.api.onSessionData(sessionId, (data) => { if (data) terminal.write(data); });
  const replies = terminal.onData((data) => preload.api.writeToSession(sessionId, data));
  const dataSubscription = pty.onData((data) => {
    raw += data;
    rawTerminal.write(data);
    emit(data);
    stream.emit("data", Buffer.from(data));
  });
  const exitSubscription = pty.onExit(() => stream.emit("close"));
  t.after(async () => {
    closed = true;
    await preload.api.closeSession(sessionId);
    dataSubscription.dispose();
    exitSubscription.dispose();
    replies.dispose();
    cursorSync?.dispose();
    try { pty.kill(); } catch { /* Already exited. */ }
    // node-pty's ConPTY DLL branch waits for one final data event to dispose
    // this owned worker. An idle shell may exit without producing that event.
    pty._agent?._conoutSocketWorker?.dispose?.();
    terminal.dispose();
    rawTerminal.dispose();
    preload.cleanup();
    if (historyPath && existsSync(historyPath)) unlinkSync(historyPath);
  });
  const flush = async () => {
    await new Promise((resolve) => terminal.write("", resolve));
    await new Promise((resolve) => rawTerminal.write("", resolve));
  };
  const lineAtCursor = (term) => {
    const buffer = term.buffer.active;
    return (buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || "").trimEnd();
  };
  const lines = (term = terminal) => {
    const buffer = term.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index)?.translateToString(true) || "");
  };
  const waitFor = async (predicate, description, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await sleep(25);
      await flush();
      if (predicate()) return;
    }
    assert.fail(`${shell.label}: ${description}; raw=${JSON.stringify(lines(rawTerminal).filter(Boolean).slice(-6))}; display=${JSON.stringify(lines().filter(Boolean).slice(-6))}`);
  };
  const promptPattern = shell.kind === "cmd" ? /^[A-Za-z]:\\[^\r\n]*>\s*$/ : /^PS [^\r\n]*>\s*$/;
  const prompt = () => lineAtCursor(rawTerminal);
  await waitFor(() => promptPattern.test(prompt()), "initial shell prompt", 10_000);
  let idlePrompt = prompt();
  const type = async (text) => {
    for (const character of text) {
      notifyConptyCursorSyncInput(terminal, character);
      preload.api.writeToSession(sessionId, character);
      await sleep(1);
    }
    await sleep(50);
    await flush();
  };
  const submit = async (text) => {
    await type(`${text}\r`);
    await waitFor(() => promptPattern.test(prompt()), `prompt after ${text}`);
    idlePrompt = prompt();
    await sleep(100);
    await flush();
  };
  const seedHistory = async (text) => {
    // Reproduce an old hidden MCP history entry, not a visible user-typed
    // marker. Only this test's own shell and renderer control are involved.
    const marker = "__NCMCP_historyseed__";
    emit(marker + "_I\n", { mcpConptyCursorSync: true });
    pty.write(text + "\r");
    await waitFor(() => promptPattern.test(prompt()), "prompt after old history seed");
    await sleep(100);
    emit(marker + "_R\n", { mcpConptyCursorSync: true });
    idlePrompt = prompt();
    await flush();
  };
  const arrow = async (direction, expected) => {
    const rawStart = raw.length;
    const sentStart = preload.sent.length;
    notifyConptyCursorSyncInput(terminal, direction === "up" ? "\x1b[A" : "\x1b[B");
    preload.api.writeToSession(sessionId, win32Arrow(direction));
    try {
      await waitFor(() => prompt().endsWith(expected) && lineAtCursor(terminal).endsWith(expected), `${direction} recalls ${expected}`, 10_000);
    } catch (error) {
      t.diagnostic(JSON.stringify({ direction, rawRedraw: raw.slice(rawStart), writes: preload.sent.slice(sentStart).filter((event) => event.channel === "netcatty:write").map((event) => event.payload.data) }));
      throw error;
    }
    await sleep(100);
    await flush();
    assert.ok(prompt().endsWith(expected), `native editor retained ${expected}`);
    assert.ok(lineAtCursor(terminal).endsWith(expected), `display retained ${expected}`);
  };
  const runAgent = async (command) => {
    const result = await execViaPty(stream, command, {
      shellKind: shell.kind, expectedPrompt: idlePrompt, timeoutMs: 10_000,
      typedInput: true, windowsConpty: true, probeLiveShell: true,
      onEchoSuppressionPrime: (marker) => emit(`${marker}_I\n`, { mcpConptyCursorSync: true }),
      onProbeAborted: (marker) => emit(`${marker}_R\n`, { mcpConptyCursorSync: true }),
      echoCommand: (text) => emit(`${text}\r\n`, { syntheticEcho: true }),
    });
    assert.equal(result.ok, true, `${shell.label}: ${JSON.stringify(result)}`);
    assert.equal(result.exitCode, 0);
    await waitFor(() => promptPattern.test(prompt()), "returned agent prompt");
    idlePrompt = prompt();
    await sleep(100);
    await flush();
    return result;
  };
  const inspectParentHistory = async () => {
    const nonce = randomUUID().replaceAll("-", "");
    const prefix = "NETCATTY_NATIVE_" + nonce + ":";
    const marker = "__NCMCP_parentprobe__";
    const script = "$__NCMCP_opt=Get-PSReadLineOption;" +
      "$__NCMCP_items=[Microsoft.PowerShell.PSConsoleReadLine]::GetHistoryItems();" +
      "$__NCMCP_result=[ordered]@{" +
      "version=(@(Get-Module PSReadLine|ForEach-Object {$_.Version.ToString()}) -join ',');" +
      "moduleCount=@(Get-Module PSReadLine).Count;" +
      "pendingExecuted=[bool](Get-Variable NC_TEST_PENDING -Scope Global -ValueOnly -ea Ignore);" +
      "installed=[object]::ReferenceEquals($__NCMCP_opt.AddToHistoryHandler,$global:__NCMCP_historyGuard);" +
      "hidden=if($__NCMCP_opt.AddToHistoryHandler){[string]$__NCMCP_opt.AddToHistoryHandler.Invoke('$__NCMCP_hidden=1')}else{'none'};" +
      "historyCount=@($__NCMCP_items).Count;internalCount=@($__NCMCP_items|Where-Object CommandLine -like '*__NCMCP_*').Count};" +
      "Write-Output ('NETCATTY_'+'NATIVE_" + nonce + ":'+" +
      "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($__NCMCP_result|ConvertTo-Json -Compress)))+':END')";
    const result = () => lines(rawTerminal).join("").match(new RegExp(prefix + "([A-Za-z0-9+/=]+):END"));
    emit(marker + "_I\n", { mcpConptyCursorSync: true });
    pty.write(script + "\r");
    await waitFor(() => result(), "interactive parent history probe");
    const json = JSON.parse(Buffer.from(result()[1], "base64").toString("utf8"));
    await waitFor(() => promptPattern.test(prompt()), "prompt after interactive history probe");
    emit(marker + "_R\n", { mcpConptyCursorSync: true });
    idlePrompt = prompt();
    await sleep(100);
    await flush();
    return json;
  };
  return { shell, sessionId, preload, terminal, rawTerminal, prompt, promptPattern, lines, type, submit, seedHistory, arrow, runAgent, inspectParentHistory, waitFor, flush, raw: () => raw };
}

for (const shell of nativeShells) {
  test(`owned ConPTY ${shell.label} preserves manual history across consecutive agent jobs`, {
    skip: !windows || !existsSync(shell.executable), timeout: 45_000,
  }, async (t) => {
    const harness = await createNativeHarness(shell, t);
    const manual = (suffix) => shell.kind === "cmd" ? `echo NETCATTY_MANUAL_${suffix}` : `Write-Output 'NETCATTY_MANUAL_${suffix}'`;
    await harness.submit(manual("A"));
    await harness.seedHistory(shell.kind === "cmd" ? 'set "__NCMCP_old=history"' : "$__NCMCP_old='history'");
    await harness.submit(manual("B"));
    // A side effect detects stale input executed BEFORE _S, which successful
    // MCP stdout alone cannot detect. The variable exists only in this PTY.
    await harness.type(shell.kind === "cmd" ? "set NC_TEST_PENDING=1 & " : "$global:NC_TEST_PENDING=1; ");
    for (let index = 1; index <= 2; index += 1) {
      // The PTY executor must clear pending input and observe the returned prompt
      // before the next job. Synthetic echo and completion mirror MCP handlers.
      const command = shell.kind === "cmd" ? `echo NETCATTY_AGENT_${index}` : `Write-Output 'NETCATTY_AGENT_${index}'`;
      const result = await harness.runAgent(command);
      assert.match(result.stdout, new RegExp(`NETCATTY_AGENT_${index}`));
      assert.doesNotMatch(result.stdout, /NC_TEST_PENDING/);
    }
    assert.doesNotMatch(harness.lines().join("\n"), /__NCMCP_|Invoke-Expression|errorlevel/i);
    for (const marker of ["NETCATTY_MANUAL_A", "NETCATTY_MANUAL_B", "NETCATTY_AGENT_1", "NETCATTY_AGENT_2"]) {
      assert.equal(harness.lines().filter((line) => line.trim() === marker).length, 1, `${marker} must display once`);
    }
    if (shell.kind === "cmd") {
      const pending = await harness.runAgent("if defined NC_TEST_PENDING (echo NETCATTY_PENDING_EXECUTED) else (echo NETCATTY_PENDING_CLEAR)");
      assert.equal(pending.stdout.trim(), "NETCATTY_PENDING_CLEAR", "unsubmitted input must not execute before the start marker");
    } else {
      const pending = await harness.inspectParentHistory();
      assert.equal(pending.moduleCount, 1);
      assert.equal(pending.pendingExecuted, false, "unsubmitted input must not execute before the start marker");
    }
    const navigationStart = harness.preload.sent.length;
    await harness.arrow("up", manual("B"));
    await harness.arrow("up", manual("A"));
    await harness.arrow("down", manual("B"));
    const navigationWrites = harness.preload.sent.slice(navigationStart)
      .filter((event) => event.channel === "netcatty:write");
    assert.ok(navigationWrites.every((event) => ["arrow", "ignore"].includes(classifyHistoryInput(event.payload.data).kind)),
      "history navigation sends only arrows and terminal protocol replies, never Enter");
    assert.equal(harness.lines().filter((line) => line.trim() === "NETCATTY_MANUAL_B").length, 1,
      "history navigation never executes a recalled command");
    assert.doesNotMatch(harness.lines().join("\n"), /__NCMCP_|Invoke-Expression|errorlevel/i);
    const before = harness.preload.sent.filter((event) => event.channel === "netcatty:write").length;
    // New typing cancels a pending skip instead of racing a stale arrow timer.
    harness.preload.api.writeToSession(harness.sessionId, win32Arrow("up"));
    await harness.type("X");
    await sleep(150);
    const after = harness.preload.sent.filter((event) => event.channel === "netcatty:write").length;
    assert.equal(after - before, 2, "only the explicit arrow and new character are sent");
  });
}

for (const shell of nativeShells.filter((shell) => shell.kind === "powershell")) {
  test(`owned ConPTY ${shell.label} history guard excludes repeated job statements`, {
    skip: !windows || !existsSync(shell.executable), timeout: 40_000,
  }, async (t) => {
    const harness = await createNativeHarness(shell, t);
    await harness.runAgent("Write-Output 'NETCATTY_HISTORY_FIRST'");
    const first = await harness.inspectParentHistory();
    await harness.runAgent("Write-Output 'NETCATTY_HISTORY_SECOND'");
    const second = await harness.inspectParentHistory();
    t.diagnostic(JSON.stringify({ first, second }));
    assert.equal(first.moduleCount, 1, "the active editor and queried options must use one PSReadLine module");
    if (shell.module.includes("2.0.0")) assert.equal(first.version, "2.0.0");
    assert.equal(first.installed, true);
    assert.equal(first.hidden, "False");
    assert.equal(second.installed, true);
    assert.equal(second.hidden, "False");
    assert.equal(second.internalCount, first.internalCount, "a guarded job adds no internal editor history");
  });
}
