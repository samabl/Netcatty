"use strict";

/**
 * IPC surface for calling user-configured external MCP servers.
 *
 * The renderer owns the server list (Settings -> AI) and syncs it here; this
 * module exposes only the manager's lifecycle, catalog and call surface. Every
 * handler re-validates the sender and normalizes its payload; the manager
 * re-validates the config again, so a compromised renderer cannot widen scope.
 */

function registerExternalMcpClientHandlers(ctx) {
  const {
    ipcMain,
    validateSender,
    validateSenderOrSettings,
    mcpClientManager,
  } = ctx;

  function ensureManager() {
    if (!mcpClientManager) {
      return { ok: false, error: "External MCP client is unavailable." };
    }
    return null;
  }

  ipcMain.handle("netcatty:ai:mcp-client:set-servers", async (event, payload) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const unavailable = ensureManager();
    if (unavailable) return unavailable;
    try {
      await mcpClientManager.setServers(payload?.servers);
      return { ok: true, status: mcpClientManager.getStatus() };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:mcp-client:status", async (event) => {
    if (!validateSenderOrSettings(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const unavailable = ensureManager();
    if (unavailable) return unavailable;
    try {
      return { ok: true, status: mcpClientManager.getStatus() };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:mcp-client:list-tools", async (event) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const unavailable = ensureManager();
    if (unavailable) return unavailable;
    try {
      return { ok: true, tools: mcpClientManager.listTools() };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle("netcatty:ai:mcp-client:call-tool", async (event, payload) => {
    if (!validateSender(event)) return { ok: false, error: "Unauthorized IPC sender" };
    const unavailable = ensureManager();
    if (unavailable) return { error: unavailable.error };
    const { serverId, toolName, args, timeoutMs } = payload || {};
    if (typeof serverId !== "string" || !serverId) return { error: "serverId is required." };
    if (typeof toolName !== "string" || !toolName) return { error: "toolName is required." };
    try {
      return await mcpClientManager.callTool(
        serverId,
        toolName,
        args && typeof args === "object" ? args : {},
        { timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : undefined },
      );
    } catch (err) {
      return { error: err?.message || String(err) };
    }
  });
}

module.exports = { registerExternalMcpClientHandlers };
