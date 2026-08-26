import { describe, expect, it } from "vitest";

import { buildReadOnlyServer, MCP_PATH } from "../../src/http.js";

describe("read-only HTTP server", () => {
  it("builds without a wallet or a project id", () => {
    // Reads need only an RPC endpoint; the HTTP half must never require
    // WC_PROJECT_ID, which is what makes it hostable.
    expect(() => buildReadOnlyServer()).not.toThrow();
  });

  it("serves MCP at /mcp", () => {
    expect(MCP_PATH).toBe("/mcp");
  });

  it("does not import the write or wallet modules at all", async () => {
    // The write path must be unreachable over HTTP by construction, not by
    // configuration. Checked against import statements, not prose — the file
    // mentions these modules in a comment explaining why it avoids them.
    const fs = await import("node:fs");
    const source = fs.readFileSync(new URL("../../src/http.ts", import.meta.url), "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+"/.test(line))
      .join("\n");

    for (const forbidden of ["tools/writes", "tools/wallet", "wc/client", "wc/session"]) {
      expect(imports, `http.ts must not import ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("exposes exactly the read surface", async () => {
    const registered: string[] = [];
    const server = buildReadOnlyServer() as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    for (const name of Object.keys(server._registeredTools ?? {})) registered.push(name);

    expect(registered).toContain("moi_get_account");
    expect(registered).not.toContain("moi_transfer");
    expect(registered).not.toContain("moi_create_asset");
    expect(registered).not.toContain("moi_connect_wallet");
  });
});
