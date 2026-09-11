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

/** Depth bound so a self-referential schema cannot loop forever. */
const MAX_INLINE_DEPTH = 8;

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

/** Resolve one RFC 6901 JSON Pointer ("#/properties/supply") against a root. */
function resolvePointer(root: unknown, pointer: string): unknown {
  if (pointer === "#" || pointer === "") return root;
  if (!pointer.startsWith("#/")) return undefined;

  let node: unknown = root;
  for (const rawSegment of pointer.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Replace internal `$ref`s with the schema they point at.
 *
 * zod-to-json-schema deduplicates structurally identical sub-schemas into
 * `$ref: "#/properties/…"`. A client that does not resolve JSON Pointers sees
 * a bare `{}` — no type at all — so it infers the type from the value it is
 * given. That is how `storageFund` (a `$ref` to the identical `supply`) became
 * unreachable: the client sent the number 50000 against an empty schema, and
 * our validator rejected it for not being a decimal string. There was no value
 * satisfying both.
 *
 * Inlining costs a little duplication and makes every property self-describing.
 * Returns the number of refs resolved.
 */
export function inlineLocalRefs(root: unknown, depth = 0): number {
  if (depth > MAX_INLINE_DEPTH || !root || typeof root !== "object") return 0;

  let resolved = 0;
  const visit = (node: unknown, level: number): unknown => {
    if (level > MAX_INLINE_DEPTH) return node;
    if (Array.isArray(node)) return node.map((item) => visit(item, level + 1));
    if (!node || typeof node !== "object") return node;

    const record = node as Record<string, unknown>;
    const ref = record["$ref"];
    if (typeof ref === "string") {
      const target = resolvePointer(root, ref);
      if (target && typeof target === "object") {
        resolved += 1;
        const { $ref: _dropped, ...siblings } = record;
        // Siblings win: in 2020-12 they are annotations alongside the $ref.
        return { ...(visit(structuredClone(target), level + 1) as object), ...siblings };
      }
      return node; // unresolvable — leave it rather than guess
    }

    for (const key of Object.keys(record)) record[key] = visit(record[key], level + 1);
    return record;
  };

  visit(root, 0);
  return resolved;
}

/** Normalise every tool schema in a tools/list result. */
function normalizeToolSchemas(message: unknown): void {
  const tools = (message as { result?: { tools?: unknown } })?.result?.tools;
  if (!Array.isArray(tools)) return;

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") continue;
    const record = tool as Record<string, unknown>;
    for (const key of ["inputSchema", "outputSchema"]) {
      const schema = record[key];
      if (!schema || typeof schema !== "object") continue;
      // Each schema is its own document, so refs resolve against it alone.
      inlineLocalRefs(schema);
    }
  }
}

/**
 * Wrap a transport so every outgoing message declares a dialect clients
 * accept. Applied at the transport rather than at registration because the
 * SDK converts zod to JSON Schema lazily, when `tools/list` is answered.
 */
export function withModernSchemaDialect<T extends Transport>(transport: T): T {
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    normalizeToolSchemas(message);
    modernizeSchemaDialect(message);
    return send(message, options);
  };
  return transport;
}
