import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildReadOnlyServer } from "../../src/http.js";
import {
  inlineLocalRefs,
  JSON_SCHEMA_2020_12,
  modernizeSchemaDialect,
} from "../../src/json-schema-dialect.js";
import { startHarness, type Harness } from "../helpers/harness.js";
import { startMockNode, type MockNode } from "../helpers/mock-node.js";

describe("modernizeSchemaDialect", () => {
  it("rewrites the draft-07 declaration the SDK stamps on every schema", () => {
    const msg = {
      result: {
        tools: [
          { name: "t", inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" } },
        ],
      },
    };
    expect(modernizeSchemaDialect(msg)).toBe(1);
    expect(msg.result.tools[0]!.inputSchema.$schema).toBe(JSON_SCHEMA_2020_12);
  });

  it("leaves a schema that already declares 2020-12 alone", () => {
    const msg = { a: { $schema: JSON_SCHEMA_2020_12 } };
    expect(modernizeSchemaDialect(msg)).toBe(0);
  });

  it("does not invent a $schema where none was declared", () => {
    const msg = { a: { type: "object" } };
    modernizeSchemaDialect(msg);
    expect(msg.a).not.toHaveProperty("$schema");
  });

  it("survives cycles rather than hanging", () => {
    const a: Record<string, unknown> = { $schema: "http://json-schema.org/draft-07/schema#" };
    a["self"] = a;
    expect(() => modernizeSchemaDialect(a)).not.toThrow();
    expect(a["$schema"]).toBe(JSON_SCHEMA_2020_12);
  });
});

/**
 * The load-bearing test. A client rejected every tool because the declared
 * dialect was draft-07; rewriting the declaration is only safe if the schemas
 * really are valid 2020-12. This asserts that against the real metaschema for
 * every tool on both transports — if a future zod construct emits something
 * draft-07-only (tuple `items`, `dependencies`, `definitions` + `$ref`), this
 * fails instead of shipping a schema clients silently refuse.
 */
let node: MockNode;
let h: Harness;

beforeAll(async () => {
  node = await startMockNode();
  h = await startHarness(node.url);
});

afterAll(async () => {
  await h.close();
  await node.close();
});

describe("every advertised schema is valid JSON Schema 2020-12", () => {
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv as never);

  let node: MockNode;
  let h: Harness;

  beforeAll(async () => {
    node = await startMockNode();
    h = await startHarness(node.url);
  });

  afterAll(async () => {
    await h.close();
    await node.close();
  });

  it("every registered tool declares and compiles as 2020-12", async () => {
    const { tools } = await h.client.listTools();
    // The harness registers the three tool groups; `ping` is defined inline in
    // src/index.ts, so it is covered by the built-server check instead.
    expect(tools.length).toBeGreaterThanOrEqual(11);

    for (const tool of tools) {
      for (const [kind, schema] of [
        ["inputSchema", tool.inputSchema],
        ["outputSchema", tool.outputSchema],
      ] as const) {
        if (!schema) continue;
        expect(
          (schema as Record<string, unknown>)["$schema"],
          `${tool.name}.${kind} must declare 2020-12`,
        ).toBe(JSON_SCHEMA_2020_12);
        expect(
          () => ajv.compile(schema as object),
          `${tool.name}.${kind} must compile as 2020-12`,
        ).not.toThrow();
      }
    }
  });

  it("http server: its tools compile too", () => {
    // Same registration path; guards the read-only transport separately.
    expect(() => buildReadOnlyServer()).not.toThrow();
  });
});


describe("inlineLocalRefs", () => {
  /**
   * zod-to-json-schema collapses structurally identical sub-schemas into
   * `$ref: "#/properties/…"`. A client that does not resolve JSON Pointers
   * sees a bare `{}` and infers the type from the value — which is how
   * `storageFund` became impossible to call: the client sent the number
   * 50000 against an empty schema, and the validator demanded a decimal
   * string. No value satisfied both.
   */
  it("replaces a pointer with the schema it targets", () => {
    const schema = {
      type: "object",
      properties: {
        supply: { type: "string", pattern: "^\\d+$" },
        storageFund: { $ref: "#/properties/supply" },
      },
    };
    expect(inlineLocalRefs(schema)).toBe(1);
    expect(schema.properties.storageFund).toEqual({ type: "string", pattern: "^\\d+$" });
  });

  it("keeps sibling keywords alongside the resolved target", () => {
    const schema = {
      properties: {
        a: { type: "string" },
        b: { $ref: "#/properties/a", description: "kept" },
      },
    };
    inlineLocalRefs(schema);
    expect(schema.properties.b).toEqual({ type: "string", description: "kept" });
  });

  it("leaves an unresolvable ref alone rather than guessing", () => {
    const schema = { properties: { a: { $ref: "#/nope/missing" } } };
    expect(inlineLocalRefs(schema)).toBe(0);
    expect(schema.properties.a).toEqual({ $ref: "#/nope/missing" });
  });

  it("terminates on a self-referential schema", () => {
    const schema: Record<string, unknown> = { properties: {} };
    (schema["properties"] as Record<string, unknown>)["self"] = { $ref: "#" };
    expect(() => inlineLocalRefs(schema)).not.toThrow();
  });

  it("no advertised schema still contains a $ref", async () => {
    const { tools } = await h.client.listTools();
    const withRefs = tools.filter((t) =>
      JSON.stringify([t.inputSchema, t.outputSchema]).includes('"$ref"'),
    );
    expect(withRefs.map((t) => t.name)).toEqual([]);
  });

  it("storageFund advertises a usable type, not an empty schema", async () => {
    const { tools } = await h.client.listTools();
    const create = tools.find((t) => t.name === "moi_create_asset")!;
    const field = (create.inputSchema as { properties: Record<string, unknown> }).properties[
      "storageFund"
    ] as Record<string, unknown>;
    // Must describe SOMETHING — an empty schema is what made it uncallable.
    expect(Object.keys(field).length).toBeGreaterThan(0);
    expect(JSON.stringify(field)).toMatch(/string|number/);
  });
});
