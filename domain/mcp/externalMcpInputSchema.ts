/**
 * Normalize a third-party MCP tool input schema into a JSON Schema object the
 * AI SDK can forward to providers.
 *
 * MCP servers publish `inputSchema` as JSON Schema, but the dialect varies:
 * some omit `type`, some list `required` entries that have no matching
 * property, and some emit non-object roots. Providers reject those, so the
 * shape is repaired here rather than at call time.
 */

export interface ExternalMcpJsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeExternalMcpInputSchema(raw: unknown): ExternalMcpJsonSchema {
  const record = asRecord(raw) ?? {};
  const rawProperties = asRecord(record.properties) ?? {};

  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rawProperties)) {
    if (!key) continue;
    properties[key] = asRecord(value) ?? {};
  }

  const schema: ExternalMcpJsonSchema = {
    ...record,
    type: 'object',
    properties,
  };

  const required = Array.isArray(record.required)
    ? record.required.filter(
        (entry): entry is string => typeof entry === 'string' && Object.hasOwn(properties, entry),
      )
    : [];
  if (required.length) {
    schema.required = required;
  } else {
    delete schema.required;
  }

  if (typeof schema.additionalProperties !== 'boolean') {
    schema.additionalProperties = true;
  }

  return schema;
}

/** JSON Schema for the no-argument case, which must stay an open object. */
export function emptyExternalMcpInputSchema(): ExternalMcpJsonSchema {
  return { type: 'object', properties: {}, additionalProperties: true };
}
