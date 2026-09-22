import assert from "node:assert/strict";
import test from "node:test";

import en from "./en.ts";
import ru from "./ru.ts";
import es from "./es.ts";
import zhCN from "./zh-CN.ts";
import zhTW from "./zh-TW.ts";

const KEYS = [
  "ai.mcpServers.import",
  "ai.mcpServers.import.title",
  "ai.mcpServers.import.description",
  "ai.mcpServers.import.placeholder",
  "ai.mcpServers.import.chooseFile",
  "ai.mcpServers.import.summary",
  "ai.mcpServers.import.badge.add",
  "ai.mcpServers.import.badge.update",
  "ai.mcpServers.import.skipped",
  "ai.mcpServers.import.unnamed",
  "ai.mcpServers.import.skip.invalidEntry",
  "ai.mcpServers.import.skip.limitReached",
  "ai.mcpServers.import.error.invalidJson",
  "ai.mcpServers.import.error.unsupportedShape",
  "ai.mcpServers.import.fileError",
  "ai.mcpServers.import.imported",
  "ai.mcpServers.import.confirm",
  "ai.mcpServers.import.cancel",
] as const;

test("external MCP JSON import copy exists in every locale", () => {
  for (const [locale, messages] of Object.entries({ en, ru, es, zhCN, zhTW })) {
    const missing = KEYS.filter((key) => !messages[key]);
    assert.deepEqual(missing, [], locale + " is missing external MCP import labels");
  }
});
