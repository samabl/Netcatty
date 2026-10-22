const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createMcpOscFilter } = require("./mcpOscFilter.cjs");

function splitAtEveryBoundary(input, expected) {
  for (let offset = 0; offset <= input.length; offset += 1) {
    const filter = createMcpOscFilter();
    const parts = [
      ...filter.split("session", input.slice(0, offset)),
      ...filter.split("session", input.slice(offset)),
    ];
    assert.equal(parts.map((part) => part.data).join(""), expected, `split at ${offset}`);
    assert.equal(filter.hasBuffered("session"), false);
  }
  const filter = createMcpOscFilter();
  const parts = [...input].flatMap((char) => filter.split("session", char));
  assert.equal(parts.map((part) => part.data).join(""), expected, "one-character chunks");
  assert.equal(filter.hasBuffered("session"), false);
}

test("ordinary OSC titles, hyperlinks and CSI colors survive every split boundary", () => {
  const input = "before\u001b]0;CMD\u0007\u001b[32mgreen\u001b[0m"
    + "\u001b]8;;https://example.test/\u001b\\link\u001b]8;;\u001b\\after";
  splitAtEveryBoundary(input, input);
});

test("internal titles are removed with all OSC introducers and terminators", () => {
  for (const start of ["\u001b]", "\u009d"]) {
    for (const end of ["\u0007", "\u001b\\", "\u009c"]) {
      for (const selector of ["0", "2", "00", "02"]) {
        const title = `${start}${selector};CMD echo __NCMCP_internal___S & hidden${end}`;
        splitAtEveryBoundary(`before${title}after\r\nC:\\>`, "beforeafter\r\nC:\\>");
      }
    }
  }
});

test("non-title OSC payloads containing reserved markers remain opaque", () => {
  const input = "\u001b]8;;https://example.test/__NCMCP_link___S\u001b\\"
    + "visible\u001b]8;;\u001b\\"
    + "\u001b]133;__NCMCP_integration___E:0\u0007";
  splitAtEveryBoundary(input, input);
  const parts = createMcpOscFilter().split("session", input);
  assert.ok(parts.filter((part) => part.kind === "text").every((part) => !part.data.includes("__NCMCP_")));
});

test("clipboard and image OSC payloads stream without title-sized buffering", () => {
  for (const selector of ["52;c;", "1337;File=inline=1:"]) {
    const filter = createMcpOscFilter();
    const start = `\u001b]${selector}`;
    assert.equal(filter.split("session", start).map((part) => part.data).join(""), start);
    assert.equal(filter.hasBuffered("session"), false);
    const fragment = "A".repeat(4096);
    for (let index = 0; index < 70; index += 1) {
      assert.deepEqual(filter.split("session", fragment), [{ kind: "osc", data: fragment }]);
      assert.equal(filter.hasBuffered("session"), false);
    }
    assert.deepEqual(filter.split("session", "\u0007done"), [
      { kind: "osc", data: "\u0007" }, { kind: "text", data: "done" },
    ]);
  }
});

test("internal and oversized titles discard until a split terminator", () => {
  for (const payload of ["__NCMCP_internal___S", "x".repeat(70 * 1024)]) {
    const filter = createMcpOscFilter();
    assert.deepEqual(filter.split("session", `\u001b]0;${payload}`), []);
    assert.equal(filter.hasBuffered("session"), false);
    for (let index = 0; index < 20; index += 1) {
      assert.deepEqual(filter.split("session", "x".repeat(4096)), []);
      assert.equal(filter.hasBuffered("session"), false);
    }
    assert.deepEqual(filter.split("session", "\u001b"), []);
    assert.deepEqual(filter.split("session", "\\visible"), [{ kind: "text", data: "visible" }]);
  }
});

test("OSC state is isolated by session and cleared on cleanup", () => {
  const filter = createMcpOscFilter();
  assert.deepEqual(filter.split("one", "\u001b]0;normal"), []);
  assert.equal(filter.hasBuffered("one"), true);
  assert.deepEqual(filter.split("two", "two-output"), [{ kind: "text", data: "two-output" }]);
  assert.deepEqual(filter.split("one", " title\u0007one-output"), [
    { kind: "osc", data: "\u001b]0;normal title\u0007" },
    { kind: "text", data: "one-output" },
  ]);
  filter.split("one", "\u001b]0;unfinished");
  filter.clear("one");
  assert.equal(filter.hasBuffered("one"), false);
  assert.deepEqual(filter.split("one", "fresh"), [{ kind: "text", data: "fresh" }]);
  filter.split("one", "\u001b");
  assert.equal(filter.hasBuffered("one"), true);
  filter.clear("one");
  assert.deepEqual(filter.split("one", "]plain"), [{ kind: "text", data: "]plain" }]);
});
