import test from "node:test";
import assert from "node:assert/strict";

import {
  EXTERNAL_MCP_TOOL_NAME_MAX_LENGTH,
  assignExternalMcpToolNames,
  buildExternalMcpToolName,
  isExternalMcpQualifiedToolName,
  sanitizeExternalMcpSegment,
} from "./externalMcpToolName.ts";

test("sanitizeExternalMcpSegment keeps a provider-safe alphabet", () => {
  assert.equal(sanitizeExternalMcpSegment("Files System!"), "files_system");
  assert.equal(sanitizeExternalMcpSegment("a--b__c"), "a_b_c");
  assert.equal(sanitizeExternalMcpSegment("  "), "server");
  assert.equal(sanitizeExternalMcpSegment("Qdrant_Server"), "qdrant_server");
});

test("buildExternalMcpToolName namespaces server and tool", () => {
  assert.equal(
    buildExternalMcpToolName("Files", "read_file"),
    "mcp__files__read_file",
  );
});

test("buildExternalMcpToolName caps length and stays stable", () => {
  const longTool = "t".repeat(120);
  const name = buildExternalMcpToolName("server", longTool);
  assert.ok(name.length <= EXTERNAL_MCP_TOOL_NAME_MAX_LENGTH, name);
  assert.equal(name, buildExternalMcpToolName("server", longTool));
  assert.ok(isExternalMcpQualifiedToolName(name));
});

test("assignExternalMcpToolNames disambiguates duplicates in input order", () => {
  const entries = assignExternalMcpToolNames([
    { serverId: "s1", serverName: "Files", toolName: "read" },
    { serverId: "s2", serverName: "Files", toolName: "read" },
  ]);
  assert.equal(entries[0].qualifiedName, "mcp__files__read");
  assert.equal(entries[1].qualifiedName, "mcp__files__read_2");
});

test("assignExternalMcpToolNames falls back to the server id when unnamed", () => {
  const [entry] = assignExternalMcpToolNames([
    { serverId: "srv-9", serverName: "", toolName: "ping" },
  ]);
  assert.equal(entry.qualifiedName, "mcp__srv_9__ping");
});

test("isExternalMcpQualifiedToolName only matches the reserved prefix", () => {
  assert.equal(isExternalMcpQualifiedToolName("mcp__files__read"), true);
  assert.equal(isExternalMcpQualifiedToolName("terminal_execute"), false);
});
