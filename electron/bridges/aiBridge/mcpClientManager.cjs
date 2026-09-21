"use strict";

/**
 * External MCP client manager (Netcatty as MCP client).
 *
 * Owns one MCP SDK client per user-configured third-party server. The renderer
 * syncs the desired list through `setServers`; this manager diffs it, connects
 * new/changed servers, disconnects removed ones, and exposes the aggregated
 * tool catalog plus `callTool`.
 *
 * Secrets arrive from the renderer already encrypted (`enc:v1:`) and are
 * unwrapped by `decryptSecret` here, so plaintext never round-trips back out.
 *
 * All mutations are serialized through one promise chain: concurrent
 * `setServers` calls (StrictMode double-mount, settings + panel) must not
 * interleave connect/disconnect work.
 */

const DEFAULT_CONNECT_TIMEOUT_MS = 20000;
const DEFAULT_CALL_TIMEOUT_MS = 60000;
const MAX_TOOLS_PER_SERVER = 128;
const MAX_TOOL_DESCRIPTION_LENGTH = 1024;
const MAX_ERROR_MESSAGE_LENGTH = 400;

const TRANSPORTS = new Set(["stdio", "http", "sse"]);

function createMcpClientManager(options = {}) {
  const {
    loadSdk = defaultLoadSdk,
    decryptSecret = (value) => value,
    logger = console,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS,
    onDidChange,
  } = options;

  /** @type {Map<string, {config: object, fingerprint: string, state: string, error: string|null, tools: object[], client: object|null, transport: object|null}>} */
  const entries = new Map();
  let mutationChain = Promise.resolve();
  let disposed = false;

  function serialize(task) {
    const run = mutationChain.then(task, task);
    // Keep the chain alive after failures; callers still see their own error.
    mutationChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function truncateError(value) {
    const text = typeof value === "string" ? value : value?.message || String(value ?? "");
    const cleaned = text.replace(/\s+/g, " ").trim();
    if (!cleaned) return "Unknown error.";
    return cleaned.length > MAX_ERROR_MESSAGE_LENGTH
      ? `${cleaned.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`
      : cleaned;
  }

  function withTimeout(promise, timeoutMs, message) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  function normalizeKeyValues(raw) {
    const out = [];
    const source = Array.isArray(raw)
      // Accept both `{name,value}` records and `[name,value]` tuples: config
      // normalization stores the tuple form, which resolveSecretMap re-reads.
      ? raw.map((entry) => (
        Array.isArray(entry) ? [entry[0], entry[1]] : [entry?.name, entry?.value]
      ))
      : raw && typeof raw === "object"
        ? Object.entries(raw)
        : [];
    for (const [name, value] of source) {
      if (typeof name !== "string" || !name.trim()) continue;
      out.push([name.trim(), typeof value === "string" ? value : String(value ?? "")]);
      if (out.length >= 64) break;
    }
    return out;
  }

  /** Decrypt one `{name,value}` list into a plain object, dropping failures. */
  function resolveSecretMap(raw) {
    const map = {};
    for (const [name, value] of normalizeKeyValues(raw)) {
      try {
        map[name] = decryptSecret(value);
      } catch {
        // A failed decrypt must not abort the whole server; skip the entry.
      }
    }
    return map;
  }

  function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) return null;
    const transport = TRANSPORTS.has(raw.transport) ? raw.transport : "stdio";
    const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim() : id;
    const config = { id, name, transport, enabled: raw.enabled !== false };
    if (Array.isArray(raw.toolAllowlist)) {
      config.toolAllowlist = raw.toolAllowlist
        .filter((entry) => typeof entry === "string" && entry.trim())
        .map((entry) => entry.trim())
        .slice(0, 256);
    }
    if (raw.autoApprove === true) config.autoApprove = true;
    if (transport === "stdio") {
      const command = typeof raw.command === "string" ? raw.command.trim() : "";
      if (!command) return null;
      config.command = command;
      config.args = Array.isArray(raw.args)
        ? raw.args.filter((entry) => typeof entry === "string").slice(0, 64)
        : [];
      if (typeof raw.cwd === "string" && raw.cwd.trim()) config.cwd = raw.cwd.trim();
      const env = normalizeKeyValues(raw.env);
      if (env.length) config.env = env;
    } else {
      const url = typeof raw.url === "string" ? raw.url.trim() : "";
      if (!url) return null;
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      } catch {
        return null;
      }
      config.url = url;
      const headers = normalizeKeyValues(raw.headers);
      if (headers.length) config.headers = headers;
    }
    return config;
  }

  /**
   * Connection identity. `name` is excluded: renaming a server must not tear
   * down a live session. Secrets are included because a changed credential
   * must force a reconnect.
   */
  function fingerprintOf(config) {
    return JSON.stringify({
      transport: config.transport,
      command: config.command,
      args: config.args,
      cwd: config.cwd,
      env: config.env,
      url: config.url,
      headers: config.headers,
      enabled: config.enabled,
    });
  }

  function publicStatus(entry) {
    return {
      id: entry.config.id,
      name: entry.config.name,
      transport: entry.config.transport,
      enabled: entry.config.enabled,
      state: entry.state,
      toolCount: entry.tools.length,
      error: entry.error,
    };
  }

  function normalizeToolInputSchema(schema) {
    if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
      return { type: "object", properties: {}, additionalProperties: true };
    }
    const properties = schema.properties && typeof schema.properties === "object" && !Array.isArray(schema.properties)
      ? schema.properties
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(properties, key))
      : [];
    const normalized = { ...schema, type: "object", properties };
    if (required.length) normalized.required = required;
    else delete normalized.required;
    if (typeof normalized.additionalProperties !== "boolean") normalized.additionalProperties = true;
    return normalized;
  }

  function toToolDescriptor(entry, tool) {
    return {
      serverId: entry.config.id,
      serverName: entry.config.name,
      toolName: typeof tool?.name === "string" ? tool.name : "",
      description: typeof tool?.description === "string"
        ? tool.description.slice(0, MAX_TOOL_DESCRIPTION_LENGTH)
        : "",
      inputSchema: normalizeToolInputSchema(tool?.inputSchema),
      readOnlyHint: tool?.annotations?.readOnlyHint === true,
    };
  }

  function selectExposedTools(entry, tools) {
    const allowlist = Array.isArray(entry.config.toolAllowlist) && entry.config.toolAllowlist.length
      ? new Set(entry.config.toolAllowlist)
      : null;
    return tools
      .filter((tool) => typeof tool?.name === "string" && tool.name)
      .filter((tool) => !allowlist || allowlist.has(tool.name))
      .slice(0, MAX_TOOLS_PER_SERVER);
  }

  function createTransports(sdk, config) {
    if (config.transport === "stdio") {
      const env = resolveSecretMap(config.env);
      const baseEnv = typeof sdk.getDefaultEnvironment === "function"
        ? sdk.getDefaultEnvironment()
        : undefined;
      return [
        new sdk.StdioClientTransport({
          command: config.command,
          args: config.args || [],
          ...(config.cwd ? { cwd: config.cwd } : {}),
          ...(Object.keys(env).length || baseEnv
            ? { env: { ...(baseEnv || {}), ...env } }
            : {}),
          stderr: "pipe",
        }),
      ];
    }
    const headers = resolveSecretMap(config.headers);
    const requestInit = Object.keys(headers).length ? { headers } : undefined;
    if (config.transport === "sse") {
      return [new sdk.SSEClientTransport(new URL(config.url), requestInit ? { requestInit } : undefined)];
    }
    return [
      new sdk.StreamableHTTPClientTransport(new URL(config.url), requestInit ? { requestInit } : undefined),
      // Some Streamable HTTP deployments still only answer the legacy SSE
      // transport; fall back rather than leaving the server permanently "error".
      new sdk.SSEClientTransport(new URL(config.url), requestInit ? { requestInit } : undefined),
    ];
  }

  async function disconnectEntry(entry) {
    const client = entry.client;
    entry.client = null;
    entry.transport = null;
    entry.tools = [];
    if (!client) return;
    try {
      await client.close();
    } catch (err) {
      logger.warn?.(("[MCP] close failed for " + entry.config.id), truncateError(err));
    }
  }

  async function connectEntry(entry, sdk) {
    entry.state = "connecting";
    entry.error = null;
    let lastError = null;
    let transports;
    try {
      transports = createTransports(sdk, entry.config);
    } catch (err) {
      entry.state = "error";
      entry.error = truncateError(err);
      return;
    }

    for (const transport of transports) {
      const client = new sdk.Client(
        { name: "netcatty", version: sdk.version || "0.0.0" },
        { capabilities: {} },
      );
      try {
        await withTimeout(
          client.connect(transport),
          connectTimeoutMs,
          `Timed out connecting to MCP server "${entry.config.name}".`,
        );
        const listed = await withTimeout(
          client.listTools(),
          connectTimeoutMs,
          `Timed out listing tools for MCP server "${entry.config.name}".`,
        );
        entry.client = client;
        entry.transport = transport;
        entry.tools = selectExposedTools(entry, Array.isArray(listed?.tools) ? listed.tools : [])
          .map((tool) => toToolDescriptor(entry, tool))
          .filter((descriptor) => descriptor.toolName);
        entry.state = "connected";
        entry.error = null;
        return;
      } catch (err) {
        lastError = err;
        try {
          await client.close();
        } catch {
          // ignore
        }
      }
    }

    entry.state = "error";
    entry.error = truncateError(lastError);
  }

  async function applyServers(rawServers) {
    if (disposed) return;
    const desired = new Map();
    for (const raw of Array.isArray(rawServers) ? rawServers : []) {
      const config = normalizeConfig(raw);
      if (!config) continue;
      desired.set(config.id, config);
    }

    let sdk = null;
    let sdkError = null;
    if (desired.size) {
      try {
        sdk = loadSdk();
      } catch (err) {
        sdkError = truncateError(err);
      }
    }

    for (const [id, entry] of entries) {
      const next = desired.get(id);
      if (!next) {
        await disconnectEntry(entry);
        entries.delete(id);
        continue;
      }
      const nextFingerprint = fingerprintOf(next);
      const mustReconnect = nextFingerprint !== entry.fingerprint;
      entry.config = next;
      entry.fingerprint = nextFingerprint;
      if (!next.enabled) {
        await disconnectEntry(entry);
        entry.state = "disabled";
        entry.error = null;
        continue;
      }
      if (mustReconnect || entry.state === "disabled" || entry.state === "error") {
        await disconnectEntry(entry);
        if (sdkError) {
          entry.state = "error";
          entry.error = sdkError;
        } else {
          await connectEntry(entry, sdk);
        }
      }
    }

    for (const [id, config] of desired) {
      if (entries.has(id)) continue;
      const entry = {
        config,
        fingerprint: fingerprintOf(config),
        state: "disabled",
        error: null,
        tools: [],
        client: null,
        transport: null,
      };
      entries.set(id, entry);
      if (!config.enabled) continue;
      if (sdkError) {
        entry.state = "error";
        entry.error = sdkError;
      } else {
        await connectEntry(entry, sdk);
      }
    }

    notifyChange();
  }

  function notifyChange() {
    if (typeof onDidChange !== "function") return;
    try {
      onDidChange(listTools());
    } catch (err) {
      logger.warn?.("[MCP] change listener failed:", truncateError(err));
    }
  }

  function setServers(rawServers) {
    return serialize(() => applyServers(rawServers));
  }

  function listTools() {
    const out = [];
    for (const entry of entries.values()) {
      if (entry.state !== "connected") continue;
      for (const tool of entry.tools) {
        out.push({
          serverId: entry.config.id,
          serverName: entry.config.name,
          toolName: tool.toolName,
          description: tool.description,
          inputSchema: tool.inputSchema,
          readOnlyHint: tool.readOnlyHint,
          // Read live: toggling auto-approval must not require a reconnect.
          autoApprove: entry.config.autoApprove === true,
        });
      }
    }
    return out;
  }

  function getStatus() {
    return Array.from(entries.values()).map(publicStatus);
  }

  function extractTextContent(content) {
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "text" && typeof item.text === "string") parts.push(item.text);
      else if (item.type === "resource" && typeof item.resource?.text === "string") parts.push(item.resource.text);
      else parts.push(JSON.stringify(item));
    }
    return parts.join("\n");
  }

  function normalizeCallResult(result) {
    const isError = result?.isError === true;
    const text = extractTextContent(result?.content);
    if (isError) return { error: text || "External MCP tool reported an error." };
    if (result?.structuredContent !== undefined) {
      return {
        ok: true,
        ...(text ? { result: text } : {}),
        structuredContent: result.structuredContent,
      };
    }
    return { ok: true, result: text || "External MCP tool completed with no output." };
  }

  async function callTool(serverId, toolName, args, callOptions = {}) {
    const entry = entries.get(serverId);
    if (!entry) return { error: `External MCP server "${serverId}" is not configured.` };
    if (entry.state !== "connected" || !entry.client) {
      return {
        error: `External MCP server "${entry.config.name}" is not connected`
          + (entry.error ? `: ${entry.error}` : "."),
      };
    }
    if (typeof toolName !== "string" || !toolName) {
      return { error: "External MCP tool name is required." };
    }
    if (!entry.tools.some((tool) => tool.toolName === toolName)) {
      return { error: `External MCP server "${entry.config.name}" does not expose tool "${toolName}".` };
    }

    const timeoutMs = Number.isFinite(callOptions.timeoutMs) && callOptions.timeoutMs > 0
      ? callOptions.timeoutMs
      : callTimeoutMs;

    try {
      const result = await withTimeout(
        entry.client.callTool(
          { name: toolName, arguments: args && typeof args === "object" ? args : {} },
          undefined,
          { timeout: timeoutMs },
        ),
        timeoutMs,
        `Timed out calling "${toolName}" on MCP server "${entry.config.name}".`,
      );
      return normalizeCallResult(result);
    } catch (err) {
      return { error: truncateError(err) };
    }
  }

  function dispose() {
    disposed = true;
    return serialize(async () => {
      for (const entry of entries.values()) await disconnectEntry(entry);
      entries.clear();
    });
  }

  return {
    setServers,
    listTools,
    getStatus,
    callTool,
    dispose,
    /** Test seam. */
    _fingerprintOf: fingerprintOf,
    _normalizeConfig: normalizeConfig,
  };
}

let cachedSdk = null;
function defaultLoadSdk() {
  if (cachedSdk) return cachedSdk;
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const stdio = require("@modelcontextprotocol/sdk/client/stdio.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
  cachedSdk = {
    Client,
    StdioClientTransport: stdio.StdioClientTransport,
    getDefaultEnvironment: stdio.getDefaultEnvironment,
    StreamableHTTPClientTransport,
    SSEClientTransport,
    version: "1.0.0",
  };
  return cachedSdk;
}

module.exports = {
  createMcpClientManager,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_TOOLS_PER_SERVER,
};
