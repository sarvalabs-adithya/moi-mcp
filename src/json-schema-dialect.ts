/**
 * Declare our tool schemas as JSON Schema 2020-12.
 *
 * The MCP SDK converts zod to JSON Schema and stamps
 * `"$schema": "http://json-schema.org/draft-07/schema#"` on every result —
 * `zod-json-schema-compat.js` calls `mapMiniTarget(undefined)`, which returns
 * `draft-7` for BOTH the Zod 3 and Zod 4 paths, and the tool registration
 * passes no target. There is no option to change it, and 1.30.0 is current.
 *
 * Strict clients refuse the tool outright: "JSON Schema declares an
 * unsupported dialect … The default validator supports JSON Schema 2020-12
 * only." That rejects the tool before it ever runs, so the server looks dead.
 *
 * The emitted schemas are already valid 2020-12 — they use only type,
 * properties, required, additionalProperties, enum, items (single-schema
 * form), format, pattern, min/maxLength, minimum, maximum, default and
 * description, with `$ref`s that are plain JSON Pointers resolving the same
 * way in either dialect. Only the declaration is wrong, so we correct it on
 * the way out. `test/unit/json-schema-dialect.test.ts` validates every emitted
 * schema against the real 2020-12 metaschema so this stays true.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

export const JSON_SCHEMA_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const OUTDATED_DIALECT = /^https?:\/\/json-schema\.org\/draft-0[467]\/schema#?$/;

/**
 * Rewrite outdated `$schema` declarations anywhere in a message, in place.
 * Returns the number of declarations changed.
 */
export function modernizeSchemaDialect(value: unknown): number {
  let changed = 0;
  const seen = new Set<object>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (seen.has(node)) return; // guard against cycles
    seen.add(node);

    const record = node as Record<string, unknown>;
    const declared = record["$schema"];
    if (typeof declared === "string" && OUTDATED_DIALECT.test(declared)) {
      record["$schema"] = JSON_SCHEMA_2020_12;
      changed += 1;
    }
    for (const key of Object.keys(record)) walk(record[key]);
  };

  walk(value);
  return changed;
}

/**
 * Wrap a transport so every outgoing message declares a dialect clients
 * accept. Applied at the transport rather than at registration because the
 * SDK converts zod to JSON Schema lazily, when `tools/list` is answered.
 */
export function withModernSchemaDialect<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    modernizeSchemaDialect(message);
    return send(message, options);
  };
  return transport;
}
