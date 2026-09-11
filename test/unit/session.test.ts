import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MoiError } from "../../src/moi-error.js";
import type { Session } from "../../src/wc/session.js";
import {
  checkValidity,
  clearSession,
  isExpired,
  loadSession,
  requireSession,
  saveSession,
  sessionPath,
} from "../../src/wc/session.js";

const homes: string[] = [];
function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-session-"));
  homes.push(dir);
  return dir;
}
afterEach(() => { for (const d of homes.splice(0)) rmSync(d, { recursive: true, force: true }); });

const NOW = 1_800_000_000_000; // fixed clock; Date.now() would make this flaky
const future = Math.floor(NOW / 1000) + 3600;

function session(overrides: Partial<Session> = {}): Session {
  return {
    version: 1,
    topic: "topic-abc",
    account: "0xabc123",
    chainId: "moi:14",
    network: "voyage",
    peer: { name: "MOI Wallet" },
    expiry: future,
    createdAt: Math.floor(NOW / 1000),
    ...overrides,
  };
}

describe("session persistence", () => {
  it("round-trips through disk", () => {
    const home = tempHome();
    saveSession(home, session());
    expect(loadSession(home)).toEqual(session());
  });

  it("writes 0600 — the file is a handle to a wallet", () => {
    const home = tempHome();
    saveSession(home, session());
    expect(statSync(sessionPath(home)).mode & 0o777).toBe(0o600);
  });

  it("returns undefined rather than throwing on corrupt or missing files", () => {
    const home = tempHome();
    expect(loadSession(home)).toBeUndefined();
    saveSession(home, session());
    require("node:fs").writeFileSync(sessionPath(home), "{not json");
    expect(loadSession(home)).toBeUndefined();
  });

  it("rejects a file that does not match the schema", () => {
    const home = tempHome();
    require("node:fs").writeFileSync(sessionPath(home), JSON.stringify({ version: 1 }));
    expect(loadSession(home)).toBeUndefined();
  });

  it("clearSession is idempotent", () => {
    const home = tempHome();
    expect(() => clearSession(home)).not.toThrow();
    saveSession(home, session());
    clearSession(home);
    expect(loadSession(home)).toBeUndefined();
  });
});

describe("validity", () => {
  it("treats expiry as unix seconds, not milliseconds", () => {
    expect(isExpired(session({ expiry: Math.floor(NOW / 1000) + 10 }), NOW)).toBe(false);
    expect(isExpired(session({ expiry: Math.floor(NOW / 1000) - 10 }), NOW)).toBe(true);
  });

  it("accepts a live session on the expected network", () => {
    expect(checkValidity(session(), "voyage", NOW)).toEqual({ valid: true });
  });

  it("flags an expired session", () => {
    const v = checkValidity(session({ expiry: Math.floor(NOW / 1000) - 1 }), "voyage", NOW);
    expect(v).toMatchObject({ valid: false, reason: "expired" });
  });

  it("flags a wallet sitting on a different network", () => {
    const v = checkValidity(session({ network: "mainnet" }), "voyage", NOW);
    expect(v).toMatchObject({ valid: false, reason: "network_mismatch" });
    expect(v.message).toMatch(/mainnet.*voyage/s);
  });

  it("checks expiry before network, so a dead session is not misreported", () => {
    const v = checkValidity(session({ network: "mainnet", expiry: 1 }), "voyage", NOW);
    expect(v.reason).toBe("expired");
  });
});

describe("requireSession", () => {
  it("returns the session when usable", () => {
    expect(requireSession(session(), "voyage", NOW).topic).toBe("topic-abc");
  });

  it("throws WALLET_NOT_CONNECTED when nothing is paired", () => {
    try { requireSession(undefined, "voyage", NOW); expect.unreachable(); }
    catch (e) { expect((e as MoiError).code).toBe("WALLET_NOT_CONNECTED"); }
  });

  it("throws NETWORK_MISMATCH — the guard that stops a cross-network send", () => {
    try { requireSession(session({ network: "mainnet" }), "voyage", NOW); expect.unreachable(); }
    catch (e) { expect((e as MoiError).code).toBe("NETWORK_MISMATCH"); }
  });

  it("throws WALLET_NOT_CONNECTED on expiry", () => {
    try { requireSession(session({ expiry: 1 }), "voyage", NOW); expect.unreachable(); }
    catch (e) { expect((e as MoiError).code).toBe("WALLET_NOT_CONNECTED"); }
  });
});
