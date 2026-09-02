import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { expandHome, loadConfig } from "../../src/config.js";

const created: string[] = [];

function tempHome(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "moi-mcp-test-")), "home");
  created.push(dir);
  return dir;
}

/** Minimum viable env: everything else must come from schema defaults. */
function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { WC_PROJECT_ID: "test-project-id", MOI_MCP_HOME: tempHome(), ...overrides };
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("applies schema defaults when only the required vars are present", () => {
    const cfg = loadConfig(baseEnv());

    expect(cfg.MOI_NETWORK).toBe("voyage");
    // Under the MCP client's 60s timeout on purpose — see schema.ts.
    expect(cfg.REQUEST_TIMEOUT_MS).toBe(55_000);
    expect(cfg.LOG_LEVEL).toBe("error");
    expect(cfg.MOI_EXPLORER_URL).toBe("https://voyage.moi.technology");
  });

  it("creates MOI_MCP_HOME with 0700 permissions", () => {
    const cfg = loadConfig(baseEnv());

    const mode = statSync(cfg.home).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it("coerces REQUEST_TIMEOUT_MS from the string the environment always gives us", () => {
    const cfg = loadConfig(baseEnv({ REQUEST_TIMEOUT_MS: "60000" }));

    expect(cfg.REQUEST_TIMEOUT_MS).toBe(60_000);
  });

  it("treats an empty value as unset so a blank .env line falls back to the default", () => {
    const cfg = loadConfig(baseEnv({ MOI_NETWORK: "", MOI_RPC_URL: "" }));

    expect(cfg.MOI_NETWORK).toBe("voyage");
    expect(cfg.MOI_RPC_URL).toBeUndefined();
  });

  it("rejects a missing WC_PROJECT_ID with an actionable message", () => {
    expect(() => loadConfig({ MOI_MCP_HOME: tempHome() })).toThrow(/WC_PROJECT_ID/);
  });

  it("rejects an unknown network", () => {
    expect(() => loadConfig(baseEnv({ MOI_NETWORK: "testnet" }))).toThrow(/MOI_NETWORK/);
  });

  it("requires MOI_RPC_URL when the network is custom", () => {
    expect(() => loadConfig(baseEnv({ MOI_NETWORK: "custom" }))).toThrow(/MOI_RPC_URL/);
  });

  it("accepts a custom network once an RPC URL is supplied", () => {
    const cfg = loadConfig(baseEnv({ MOI_NETWORK: "custom", MOI_RPC_URL: "https://rpc.example.com" }));

    expect(cfg.MOI_NETWORK).toBe("custom");
    expect(cfg.MOI_RPC_URL).toBe("https://rpc.example.com");
  });
});

describe("expandHome", () => {
  it("expands a bare tilde", () => {
    expect(expandHome("~")).toBe(process.env.HOME);
  });

  it("expands a tilde-prefixed path", () => {
    expect(expandHome("~/.moi-mcp")).toBe(join(process.env.HOME!, ".moi-mcp"));
  });

  it("leaves an absolute path untouched", () => {
    expect(expandHome("/var/tmp/moi")).toBe("/var/tmp/moi");
  });
});

describe("request timeout stays under the client's", () => {
  /**
   * The MCP client gives up after 60s by default. If the server waits longer,
   * the client reports a timeout while the approval is still live on the
   * phone — and a later tap broadcasts an interaction the user thinks was
   * cancelled.
   */
  it("defaults below the SDK's 60s client timeout", () => {
    const cfg = loadConfig(baseEnv());
    expect(cfg.REQUEST_TIMEOUT_MS).toBeLessThan(60_000);
  });

  it("still allows an explicit longer wait for non-MCP callers like the CLI", () => {
    const cfg = loadConfig(baseEnv({ REQUEST_TIMEOUT_MS: "300000" }));
    expect(cfg.REQUEST_TIMEOUT_MS).toBe(300_000);
  });
});
