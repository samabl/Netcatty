import test from "node:test";
import assert from "node:assert/strict";

import {
  emptyExternalMcpInputSchema,
  normalizeExternalMcpInputSchema,
} from "./externalMcpInputSchema.ts";

test("normalizeExternalMcpInputSchema repairs a missing type and properties", () => {
  assert.deepEqual(normalizeExternalMcpInputSchema(undefined), {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
  assert.deepEqual(normalizeExternalMcpInputSchema({ required: ["x"] }), {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
});

test("normalizeExternalMcpInputSchema drops required entries without a property", () => {
  const schema = normalizeExternalMcpInputSchema({
    type: "object",
    properties: { path: { type: "string" }, limit: { type: "number" } },
    required: ["path", "missing"],
    additionalProperties: false,
  });
  assert.deepEqual(schema.required, ["path"]);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(Object.keys(schema.properties), ["path", "limit"]);
});

test("normalizeExternalMcpInputSchema keeps a closed object closed", () => {
  const schema = normalizeExternalMcpInputSchema({
    type: "object",
    properties: {},
    additionalProperties: false,
  });
  assert.equal(schema.additionalProperties, false);
});

test("normalizeExternalMcpInputSchema replaces a non-object root", () => {
  const schema = normalizeExternalMcpInputSchema({ type: "string", properties: "nope" });
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.properties, {});
});

test("emptyExternalMcpInputSchema stays an open object", () => {
  assert.deepEqual(emptyExternalMcpInputSchema(), {
    type: "object",
    properties: {},
    additionalProperties: true,
  });
});
