"use strict";

const { z } = require("zod");
const { listMcpTools } = require("../capabilities/codegen/toolSurfaces.cjs");
const {
  createToolHandler,
  registerMcpTools,
} = require("../capabilities/codegen/mcpToolRegistry.cjs");

const MCP_TOOL_LOADER_NAME = "load_netcatty_tools";
const MCP_TOOL_CALLER_NAME = "call_netcatty_tool";

// Always visible so progressive loading never strands a client. Both are
// transport control, not Netcatty product capabilities.
const TRANSPORT_MCP_TOOL_NAMES = Object.freeze([MCP_TOOL_LOADER_NAME, MCP_TOOL_CALLER_NAME]);

// Progressive loading only works when the client re-fetches `tools/list` after
// `notifications/tools/list_changed`. Codex and Cursor CLI ignore that
// notification (openai/codex#33266), so a deferred tool stays "unsupported
// call" forever even though the server registered it. The caller tool is part
// of the initial surface and proxies any catalog tool through the exact same
// handlers, so a stale client can still reach `scripts_*` and friends.
const MCP_TOOL_CALLER_HINT =
  `If your client cannot call a tool listed here (for example it answers "unsupported call"), ` +
  `invoke it with ${MCP_TOOL_CALLER_NAME} using the same tool name and arguments.`;

// Keep the initial MCP surface small so clients can select common terminal and
// file tools reliably. The loader and the caller are the transport-control
// tools that make the deferred catalog reachable.
const CORE_MCP_TOOL_NAMES = Object.freeze([
  "get_environment",
  "session_close",
  "terminal_execute",
  "terminal_start",
  "terminal_poll",
  "terminal_stop",
  "sftp_list",
  "sftp_read_file",
  "sftp_write_file",
  "sftp_download",
  "sftp_upload",
  "vault_hosts_list",
  "host_open",
  "terminal_read_context",
]);

const DEFERRED_MCP_TOOLSETS = Object.freeze({
  attachments: Object.freeze([
    "list_attachments",
    "read_attachment",
  ]),
  sftp_advanced: Object.freeze([
    "sftp_stat",
    "sftp_home",
    "sftp_mkdir",
    "sftp_delete",
    "sftp_rename",
    "sftp_chmod",
  ]),
  vault_hosts: Object.freeze([
    "host_get",
    "vault_hosts_create",
    "vault_hosts_update",
    "vault_hosts_delete",
    "vault_hosts_import",
    "host_notes_get",
    "host_notes_set",
    "vault_identities_list",
    "vault_proxy_profiles_list",
    "vault_groups_list",
    "vault_groups_create",
    "vault_groups_update",
    "vault_groups_delete",
  ]),
  vault_notes: Object.freeze([
    "vault_notes_list",
    "vault_notes_get",
    "vault_notes_create",
    "vault_notes_update",
    "vault_notes_delete",
  ]),
  snippets: Object.freeze([
    "snippets_list",
    "snippets_get",
    "snippets_run",
    "snippets_create",
    "snippets_update",
    "snippets_delete",
  ]),
  scripts: Object.freeze([
    "scripts_list",
    "scripts_get",
    "scripts_create",
    "scripts_update",
    "scripts_delete",
    "scripts_run",
    "scripts_reference",
    "scripts_runs_list",
    "scripts_run_stop",
    "scripts_run_pause",
    "scripts_run_resume",
    "scripts_targets_set",
    "host_connect_scripts_list",
    "host_connect_scripts_set",
  ]),
  portforward: Object.freeze([
    "portforward_rules_list",
    "portforward_tunnels_list",
    "portforward_rules_create",
    "portforward_rules_update",
    "portforward_rules_duplicate",
    "portforward_rules_delete",
    "portforward_start",
    "portforward_stop",
  ]),
});

const DEFERRED_MCP_TOOLSET_NAMES = Object.freeze(Object.keys(DEFERRED_MCP_TOOLSETS));
const LOADABLE_MCP_TOOLSET_NAMES = Object.freeze([...DEFERRED_MCP_TOOLSET_NAMES, "all"]);

function buildProgressiveMcpCatalog(toolDefs = listMcpTools()) {
  const toolsByName = new Map(toolDefs.map(tool => [tool.mcpTool, tool]));
  const assignedNames = [...CORE_MCP_TOOL_NAMES];
  for (const toolset of DEFERRED_MCP_TOOLSET_NAMES) {
    assignedNames.push(...DEFERRED_MCP_TOOLSETS[toolset]);
  }

  const duplicates = assignedNames.filter((name, index) => assignedNames.indexOf(name) !== index);
  const unknown = assignedNames.filter(name => !toolsByName.has(name));
  const assignedSet = new Set(assignedNames);
  const missing = toolDefs
    .map(tool => tool.mcpTool)
    .filter(name => !assignedSet.has(name));

  if (duplicates.length || unknown.length || missing.length) {
    throw new Error(`Invalid progressive MCP tool mapping: ${JSON.stringify({
      duplicates: [...new Set(duplicates)],
      unknown,
      missing,
    })}`);
  }

  return {
    toolsByName,
    coreTools: CORE_MCP_TOOL_NAMES.map(name => toolsByName.get(name)),
    deferredToolNames: assignedNames.slice(CORE_MCP_TOOL_NAMES.length),
  };
}

function parseLoaderResult(result) {
  return JSON.stringify(result, null, 2);
}

/**
 * Mirror the catalog inputShape as JSON Schema so a client that never refreshes
 * `tools/list` can still build correct arguments for the caller tool.
 */
function buildToolInputJsonSchema(inputShape) {
  const properties = {};
  const required = [];
  for (const [fieldName, field] of Object.entries(inputShape || {})) {
    const property = { type: field.type === "number" ? "integer" : "string" };
    if (field.description) property.description = field.description;
    properties[fieldName] = property;
    if (!field.optional) required.push(fieldName);
  }
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function describeCatalogTool(toolDef, deps) {
  return {
    name: toolDef.mcpTool,
    description: deps.catalogDescription(toolDef.mcpTool, toolDef.description) || toolDef.description || "",
    inputSchema: buildToolInputJsonSchema(toolDef.inputShape),
  };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

/**
 * The caller bypasses the SDK's per-tool Zod validation (the tool being
 * dispatched is not the tool the client called), so mirror the cheap catalog
 * checks and hand the model an actionable error instead of an opaque RPC
 * failure.
 */
function validateToolArguments(toolDef, args) {
  const missing = [];
  const wrongType = [];
  for (const [fieldName, field] of Object.entries(toolDef.inputShape || {})) {
    const value = args[fieldName];
    if (value == null) {
      if (!field.optional) missing.push(fieldName);
      continue;
    }
    const expected = field.type === "number" ? "number" : "string";
    if (typeof value !== expected) wrongType.push(`${fieldName} (expected ${expected})`);
  }
  if (missing.length === 0 && wrongType.length === 0) return null;

  const problems = [];
  if (missing.length > 0) problems.push(`missing required ${missing.join(", ")}`);
  if (wrongType.length > 0) problems.push(`wrong type for ${wrongType.join(", ")}`);
  const schema = JSON.stringify(buildToolInputJsonSchema(toolDef.inputShape));
  return `Error: invalid arguments for ${toolDef.mcpTool} (${problems.join("; ")}). Expected schema: ${schema}`;
}

/**
 * Register the two transport-control tools plus the initial core surface, and
 * add catalog tools on demand. Progressive loading is transport control, not a
 * Netcatty product capability, so it intentionally lives outside the
 * capability catalog.
 */
function registerProgressiveMcpTools(server, deps, toolDefs = listMcpTools()) {
  const { toolsByName, coreTools, deferredToolNames } = buildProgressiveMcpCatalog(toolDefs);
  const loadedNames = new Set(CORE_MCP_TOOL_NAMES);

  const registerDeferredTools = (names) => {
    const newlyLoaded = names.filter(name => !loadedNames.has(name));
    if (newlyLoaded.length === 0) return [];
    registerMcpTools(
      server,
      deps,
      newlyLoaded.map(name => toolsByName.get(name)),
    );
    for (const name of newlyLoaded) loadedNames.add(name);
    return newlyLoaded;
  };

  server.tool(
    MCP_TOOL_LOADER_NAME,
    "Load more Netcatty tools by category. Choose attachments, sftp_advanced, vault_hosts, vault_notes, snippets, scripts, portforward, or all. Newly loaded tools appear immediately without restarting the MCP server, and each one is returned with its input schema.",
    {
      toolset: z.enum(LOADABLE_MCP_TOOLSET_NAMES).describe("Netcatty tool category to load"),
    },
    async ({ toolset }) => {
      const requestedNames = toolset === "all"
        ? deferredToolNames
        : DEFERRED_MCP_TOOLSETS[toolset];
      const newlyLoaded = registerDeferredTools(requestedNames);
      const alreadyLoaded = requestedNames.filter(name => !newlyLoaded.includes(name));

      return {
        content: [{
          type: "text",
          text: parseLoaderResult({
            toolset,
            newlyLoaded,
            alreadyLoaded,
            availableToolsets: LOADABLE_MCP_TOOLSET_NAMES,
            loadedCatalogToolCount: loadedNames.size,
            visibleToolCount: loadedNames.size + TRANSPORT_MCP_TOOL_NAMES.length,
            remainingCatalogToolCount: toolDefs.length - loadedNames.size,
            hint: MCP_TOOL_CALLER_HINT,
            tools: requestedNames.map(name => describeCatalogTool(toolsByName.get(name), deps)),
          }),
        }],
      };
    },
  );

  server.tool(
    MCP_TOOL_CALLER_NAME,
    `Call any Netcatty tool by name, including tools that only become visible after ${MCP_TOOL_LOADER_NAME}. Use it when your client cannot call a loaded tool directly (it answers "unsupported call", or the tool never shows up in your tool list).`,
    {
      tool: z.string().describe("Exact Netcatty tool name, for example scripts_list"),
      arguments: z.record(z.string(), z.unknown()).optional().describe(
        "Arguments for that tool, matching the inputSchema returned by load_netcatty_tools",
      ),
    },
    async ({ tool, arguments: toolArgs }) => {
      const toolName = typeof tool === "string" ? tool.trim() : "";
      if (!toolName) {
        return errorResult(`Error: ${MCP_TOOL_CALLER_NAME} requires a "tool" name.`);
      }

      const toolDef = toolsByName.get(toolName);
      if (!toolDef) {
        return errorResult(
          `Error: Unknown Netcatty tool "${toolName}". Call ${MCP_TOOL_LOADER_NAME} to list Netcatty tools.`,
        );
      }

      const callArgs = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
        ? toolArgs
        : {};
      const invalid = validateToolArguments(toolDef, callArgs);
      if (invalid) return errorResult(invalid);

      // Keep `tools/list` honest for clients that do refresh, and make repeat
      // calls cheap. Core tools are already registered.
      registerDeferredTools([toolName]);

      const handler = createToolHandler(toolDef, deps);
      return await handler(callArgs);
    },
  );

  registerMcpTools(server, deps, coreTools);
  return {
    initialToolCount: coreTools.length + TRANSPORT_MCP_TOOL_NAMES.length,
    loadedNames,
  };
}

module.exports = {
  CORE_MCP_TOOL_NAMES,
  DEFERRED_MCP_TOOLSETS,
  DEFERRED_MCP_TOOLSET_NAMES,
  LOADABLE_MCP_TOOLSET_NAMES,
  MCP_TOOL_CALLER_HINT,
  MCP_TOOL_CALLER_NAME,
  MCP_TOOL_LOADER_NAME,
  TRANSPORT_MCP_TOOL_NAMES,
  buildProgressiveMcpCatalog,
  buildToolInputJsonSchema,
  registerProgressiveMcpTools,
};
