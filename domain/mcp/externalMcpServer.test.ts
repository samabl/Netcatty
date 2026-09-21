import test from "node:test";
import assert from "node:assert/strict";

import {
  isExternalMcpServerRunnable,
  isExternalMcpTransport,
  normalizeExternalMcpKeyValues,
  redactExternalMcpServer,
  sanitizeExternalMcpServer,
  sanitizeExternalMcpServers,
  validateExternalMcpServer,
  type ExternalMcpServer,
} from "./externalMcpServer.ts";

test("isExternalMcpTransport accepts only known transports", () => {
  assert.equal(isExternalMcpTransport("stdio"), true);
  assert.equal(isExternalMcpTransport("http"), true);
  assert.equal(isExternalMcpTransport("sse"), true);
  assert.equal(isExternalMcpTransport("websocket"), false);
  assert.equal(isExternalMcpTransport(undefined), false);
});

test("normalizeExternalMcpKeyValues accepts both pair lists and object maps", () => {
  assert.deepEqual(
    normalizeExternalMcpKeyValues([{ name: "A", value: "1" }, { name: "A", value: "2" }]),
    [{ name: "A", value: "1" }],
  );
  assert.deepEqual(
    normalizeExternalMcpKeyValues({ TOKEN: "abc", N: 2 }),
    [{ name: "TOKEN", value: "abc" }, { name: "N", value: "2" }],
  );
  assert.deepEqual(normalizeExternalMcpKeyValues("nope"), []);
});

test("sanitizeExternalMcpServer keeps stdio-only fields for stdio", () => {
  const server = sanitizeExternalMcpServer({
    id: "s1",
    name: "  Files  ",
    transport: "stdio",
    command: " npx ",
    args: ["-y", "server-files", "-y"],
    cwd: "/tmp",
    env: { TOKEN: "t" },
    url: "https://ignored.example/mcp",
    headers: { X: "y" },
  });
  assert.ok(server);
  assert.equal(server.name, "Files");
  assert.equal(server.command, "npx");
  assert.deepEqual(server.args, ["-y", "server-files"]);
  assert.equal(server.cwd, "/tmp");
  assert.deepEqual(server.env, [{ name: "TOKEN", value: "t" }]);
  assert.equal(server.url, undefined);
  assert.equal(server.headers, undefined);
  assert.equal(server.enabled, true);
});

test("sanitizeExternalMcpServer keeps url-only fields for remote transports", () => {
  const server = sanitizeExternalMcpServer({
    name: "remote",
    transport: "http",
    url: "https://mcp.example/rpc",
    headers: [{ name: "Authorization", value: "Bearer x" }],
    command: "ignored",
  });
  assert.ok(server);
  assert.equal(server.transport, "http");
  assert.equal(server.url, "https://mcp.example/rpc");
  assert.deepEqual(server.headers, [{ name: "Authorization", value: "Bearer x" }]);
  assert.equal(server.command, undefined);
});

test("sanitizeExternalMcpServer derives a name from command or url", () => {
  assert.equal(
    sanitizeExternalMcpServer({ transport: "stdio", command: "C:/tools/mcp-server.exe" })?.name,
    "mcp-server",
  );
  assert.equal(
    sanitizeExternalMcpServer({ transport: "sse", url: "https://api.example.com/sse" })?.name,
    "api.example.com",
  );
  assert.equal(sanitizeExternalMcpServer({ transport: "stdio" }), null);
  assert.equal(sanitizeExternalMcpServer(null), null);
});

test("sanitizeExternalMcpServer defaults transport to stdio and preserves autoApprove opt-in", () => {
  const server = sanitizeExternalMcpServer({ name: "x", command: "run", autoApprove: "yes" });
  assert.ok(server);
  assert.equal(server.transport, "stdio");
  assert.equal(server.autoApprove, undefined);
  const opted = sanitizeExternalMcpServer({ name: "x", command: "run", autoApprove: true });
  assert.equal(opted?.autoApprove, true);
});

test("sanitizeExternalMcpServers drops duplicates and unusable entries", () => {
  const servers = sanitizeExternalMcpServers([
    { id: "a", name: "A", command: "a" },
    { id: "a", name: "A again", command: "a" },
    { name: "" },
    "nope",
  ]);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].name, "A");
});

test("validateExternalMcpServer reports transport-specific requirements", () => {
  const missingCommand: ExternalMcpServer = { id: "a", name: "A", enabled: true, transport: "stdio" };
  assert.deepEqual(validateExternalMcpServer(missingCommand), ["command-required"]);

  const missingUrl: ExternalMcpServer = { id: "b", name: "B", enabled: true, transport: "http" };
  assert.deepEqual(validateExternalMcpServer(missingUrl), ["url-required"]);

  const badUrl: ExternalMcpServer = { id: "c", name: "C", enabled: true, transport: "sse", url: "ftp://x" };
  assert.deepEqual(validateExternalMcpServer(badUrl), ["url-invalid"]);

  const ok: ExternalMcpServer = { id: "d", name: "D", enabled: true, transport: "http", url: "https://x/y" };
  assert.deepEqual(validateExternalMcpServer(ok), []);
});

test("isExternalMcpServerRunnable requires enabled and valid config", () => {
  const valid: ExternalMcpServer = { id: "a", name: "A", enabled: true, transport: "stdio", command: "x" };
  assert.equal(isExternalMcpServerRunnable(valid), true);
  assert.equal(isExternalMcpServerRunnable({ ...valid, enabled: false }), false);
  assert.equal(isExternalMcpServerRunnable({ ...valid, command: undefined }), false);
});

test("redactExternalMcpServer masks secret values", () => {
  const redacted = redactExternalMcpServer({
    id: "a",
    name: "A",
    enabled: true,
    transport: "http",
    url: "https://x/y",
    headers: [{ name: "Authorization", value: "Bearer secret" }, { name: "Empty", value: "" }],
  });
  assert.deepEqual(redacted.headers, [
    { name: "Authorization", value: "***" },
    { name: "Empty", value: "" },
  ]);
  assert.equal(redacted.url, "https://x/y");
});
