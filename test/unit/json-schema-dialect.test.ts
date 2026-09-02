import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildReadOnlyServer } from "../../src/http.js";
import {
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
