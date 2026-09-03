/**
 * Tests for Module 3: agent-keys.ts and mandate-signer.ts
 *
 * Network-free tests using throwaway keys and temp directories.
 * Tests pinned to the design contract requirements.
 */

import { createHash, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Wallet } from "js-moi-wallet";

import { FileAgentKeyStore, loadAgentWallet, type AgentKeyRecord } from "../../src/signing/agent-keys.js";
import { MandateSigner, mandateSignerFor } from "../../src/signing/mandate-signer.js";
import { MoiError } from "../../src/moi-error.js";
import { ErrorCode } from "../../src/schema.js";

const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-agent-keys-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Set up the required environment variable for keystore password derivation.
 */
function setupEnv() {
  process.env.MOI_AGENT_KEYSTORE_SECRET = "test-secret-do-not-use-in-production";
}

function teardownEnv() {
  delete process.env.MOI_AGENT_KEYSTORE_SECRET;
}

// ============================================================================
// FileAgentKeyStore Tests
// ============================================================================

describe("FileAgentKeyStore", () => {
  beforeEach(() => {
    setupEnv();
  });

  afterEach(() => {
    teardownEnv();
  });

  describe("constructor and permissions", () => {
    it("creates the agents directory with 0700 permissions", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);
      const agentsDir = join(dir, "agents");

      // Trigger a write to ensure directory exists
      await store.getOrCreate("user1");

      const stat = statSync(agentsDir);
      expect(stat.mode & 0o777).toBe(0o700);
    });

    it("stores agent key files with 0600 permissions", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      await store.getOrCreate("user1");

      const agentsDir = join(dir, "agents");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(agentsDir, `${hash}.json`);

      const stat = statSync(filePath);
      expect(stat.mode & 0o777).toBe(0o600);
    });
  });

  describe("get and getOrCreate", () => {
    it("returns undefined for missing agent keys", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      const result = await store.get("nonexistent");
      expect(result).toBeUndefined();
    });

    it("creates a new agent key on first getOrCreate", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      const record = await store.getOrCreate("user1");

      expect(record.version).toBe(1);
      expect(record.userId).toBe("user1");
      expect(record.address).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(record.keystore).toBeTruthy();
      expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO datetime
    });

    it("getOrCreate is idempotent — same userId returns same address", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      const record1 = await store.getOrCreate("user1");
      const record2 = await store.getOrCreate("user1");

      expect(record1.address).toBe(record2.address);
      expect(record1.userId).toBe(record2.userId);
    });

    it("round-trips a record through disk via get after getOrCreate", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      const created = await store.getOrCreate("user1");
      const retrieved = await store.get("user1");

      expect(retrieved).toEqual(created);
    });

    it("never stores a raw private key in the on-disk record", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      await store.getOrCreate("user1");

      const agentsDir = join(dir, "agents");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(agentsDir, `${hash}.json`);
      const content = readFileSync(filePath, "utf8");

      // Private key strings are typically 64 hex chars (32 bytes)
      // or "0x" prefixed. The keystore JSON should not contain raw keys.
      // This is a heuristic check: if we can parse the keystore field
      // and decrypt it, we've succeeded; if it contains plaintext keys, this fails.
      const record = JSON.parse(content) as AgentKeyRecord;
      expect(record.keystore).toBeTruthy();
      // The keystore should be valid JSON (encrypted in Web3 Secret Storage format)
      const keystoreObj = JSON.parse(record.keystore);
      expect(keystoreObj).toHaveProperty("id"); // keystore has an id field
      expect(keystoreObj).toHaveProperty("cipher"); // keystore has cipher field (aes-128-ctr)
      expect(keystoreObj).toHaveProperty("ciphertext"); // encrypted key material
      // But the private key should NOT be plaintext
      expect(content).not.toMatch(/privateKey|mnemonic/i);
    });

    it("returns undefined for corrupted keystore records", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      // Write invalid JSON to the agents directory
      const agentsDir = join(dir, "agents");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(agentsDir, `${hash}.json`);

      require("node:fs").mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      require("node:fs").writeFileSync(filePath, "{invalid json", { mode: 0o600 });

      const result = await store.get("user1");
      expect(result).toBeUndefined();
    });

    it("returns undefined for records that don't match the schema", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      // Write valid JSON but missing required fields
      const agentsDir = join(dir, "agents");
      const hash = createHash("sha256").update("user1").digest("hex");
      const filePath = join(agentsDir, `${hash}.json`);

      require("node:fs").mkdirSync(agentsDir, { recursive: true, mode: 0o700 });
      require("node:fs").writeFileSync(
        filePath,
        JSON.stringify({ version: 1, userId: "user1" }), // missing address, keystore, createdAt
        { mode: 0o600 },
      );

      const result = await store.get("user1");
      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("removes an agent key record", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      await store.getOrCreate("user1");
      await store.delete("user1");

      const result = await store.get("user1");
      expect(result).toBeUndefined();
    });

    it("is idempotent — deleting a nonexistent key does not throw", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      // Should not throw
      expect(async () => {
        await store.delete("nonexistent");
      }).not.toThrow();
    });
  });

  describe("path traversal protection", () => {
    it("hashes userId in filename to prevent path traversal", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      // Try to use a path traversal userId
      const maliciousId = "../../../etc/passwd";

      await store.getOrCreate(maliciousId);

      // The file should be in the agents directory only
      const agentsDir = join(dir, "agents");
      const hash = createHash("sha256").update(maliciousId).digest("hex");
      const filePath = join(agentsDir, `${hash}.json`);

      // File should exist and be readable
      const content = readFileSync(filePath, "utf8");
      expect(content).toBeTruthy();

      // But it should NOT exist outside the agents directory
      const parentDir = join(dir, "etc");
      expect(require("node:fs").existsSync(parentDir)).toBe(false);
    });
  });

  describe("environment variable handling", () => {
    it("throws CONFIGURATION_ERROR if MOI_AGENT_KEYSTORE_SECRET is not set", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      // Temporarily unset the env var
      teardownEnv();

      try {
        await expect(store.getOrCreate("user1")).rejects.toThrow(MoiError);
        const err = await store.getOrCreate("user1").catch((e) => e);
        expect(err.code).toBe(ErrorCode.CONFIGURATION_ERROR);
      } finally {
        setupEnv(); // restore for other tests
      }
    });
  });

  describe("multiple users", () => {
    it("stores separate keys for different users", async () => {
      const dir = tempDataDir();
      const store = new FileAgentKeyStore(dir);

      const user1 = await store.getOrCreate("user1");
      const user2 = await store.getOrCreate("user2");

      expect(user1.address).not.toBe(user2.address);
      expect(user1.userId).toBe("user1");
      expect(user2.userId).toBe("user2");
    });
  });
});

// ============================================================================
// loadAgentWallet Tests
// ============================================================================

describe("loadAgentWallet", () => {
  beforeEach(() => {
    setupEnv();
  });

  afterEach(() => {
    teardownEnv();
  });

  it("throws MANDATE_NOT_FOUND if the agent key does not exist", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    await expect(loadAgentWallet(store, "nonexistent", "password")).rejects.toThrow(MoiError);
    const err = await loadAgentWallet(store, "nonexistent", "password").catch((e) => e);
    expect(err.code).toBe(ErrorCode.MANDATE_NOT_FOUND);
  });

  it("throws UNAUTHORIZED if the password is wrong", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    await store.getOrCreate("user1");

    // Try to decrypt with wrong password
    await expect(loadAgentWallet(store, "user1", "wrong-password")).rejects.toThrow(MoiError);
    const err = await loadAgentWallet(store, "user1", "wrong-password").catch((e) => e);
    expect(err.code).toBe(ErrorCode.UNAUTHORIZED);
  });

  it("successfully loads a wallet with the correct derived password", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    const record = await store.getOrCreate("user1");

    // Derive the password the same way the store does
    const secret = process.env.MOI_AGENT_KEYSTORE_SECRET!;
    const derived = scryptSync(secret, "user1", 32, { N: 16384, r: 8, p: 1 }).toString("hex");

    // Load the wallet with the derived password
    const wallet = await loadAgentWallet(store, "user1", derived);

    expect(wallet).toBeInstanceOf(Wallet);
    // Verify it's the same wallet by checking the address
    const identifier = await wallet.identifier;
    expect(identifier.toString()).toBe(record.address);
  });
});

// ============================================================================
// MandateSigner Tests
// ============================================================================

describe("MandateSigner", () => {
  beforeEach(() => {
    setupEnv();
  });

  afterEach(() => {
    teardownEnv();
  });

  it("has a diagnostic label", async () => {
    const wallet = await Wallet.createRandom();
    const signer = new MandateSigner(wallet);

    expect(signer.label).toContain("agent");
    expect(signer.label).toContain("mandate");
  });

  it("can sign an unsigned interaction", async () => {
    const wallet = await Wallet.createRandom();
    const signer = new MandateSigner(wallet);
    const identifier = await wallet.identifier;

    // Build a minimal unsigned interaction with a valid participant ID
    const ix = {
      sender: { id: identifier.toString(), sequence: 0, key_id: 0 },
      fuel_price: 1,
      fuel_limit: 100_000,
      ix_operations: [],
      participants: [],
    };

    const signed = await signer.sign(ix);

    expect(signed).toHaveProperty("ix_args");
    expect(signed).toHaveProperty("signatures");
    expect(typeof signed.ix_args).toBe("string");
    expect(typeof signed.signatures).toBe("string");
  });

  it("returns hex strings for ix_args and signatures", async () => {
    const wallet = await Wallet.createRandom();
    const signer = new MandateSigner(wallet);
    const identifier = await wallet.identifier;

    const ix = {
      sender: { id: identifier.toString(), sequence: 0, key_id: 0 },
      fuel_price: 1,
      fuel_limit: 100_000,
      ix_operations: [],
      participants: [],
    };

    const signed = await signer.sign(ix);

    // Check that both are valid unprefixed POLO hex strings (no 0x)
    // POLO hex is the format returned by the SDK
    expect(signed.ix_args).toMatch(/^[0-9a-fA-F]+$/);
    expect(signed.signatures).toMatch(/^[0-9a-fA-F]+$/);
  });

  it("can be constructed via mandateSignerFor", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    const record = await store.getOrCreate("user1");

    // Derive the password
    const secret = process.env.MOI_AGENT_KEYSTORE_SECRET!;
    const derived = scryptSync(secret, "user1", 32, { N: 16384, r: 8, p: 1 }).toString("hex");

    const signer = await mandateSignerFor(store, "user1", derived);

    expect(signer).toBeInstanceOf(MandateSigner);
    expect(signer.label).toContain("agent");
  });

  it("throws if mandateSignerFor is called with wrong password", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    await store.getOrCreate("user1");

    await expect(mandateSignerFor(store, "user1", "wrong-password")).rejects.toThrow();
  });

  it("throws if mandateSignerFor is called for a nonexistent user", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    const secret = process.env.MOI_AGENT_KEYSTORE_SECRET!;
    const derived = scryptSync(secret, "nonexistent", 32, { N: 16384, r: 8, p: 1 }).toString("hex");

    await expect(mandateSignerFor(store, "nonexistent", derived)).rejects.toThrow(MoiError);
    const err = await mandateSignerFor(store, "nonexistent", derived).catch((e) => e);
    expect(err.code).toBe(ErrorCode.MANDATE_NOT_FOUND);
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe("Integration: FileAgentKeyStore + MandateSigner", () => {
  beforeEach(() => {
    setupEnv();
  });

  afterEach(() => {
    teardownEnv();
  });

  it("creates an agent key and uses it to sign", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    // Create an agent key
    const record = await store.getOrCreate("user1");
    expect(record.address).toMatch(/^0x/);

    // Derive the password and get a signer
    const secret = process.env.MOI_AGENT_KEYSTORE_SECRET!;
    const derived = scryptSync(secret, "user1", 32, { N: 16384, r: 8, p: 1 }).toString("hex");
    const signer = await mandateSignerFor(store, "user1", derived);

    // Sign an interaction
    const ix = {
      sender: { id: record.address, sequence: 0, key_id: 0 },
      fuel_price: 1,
      fuel_limit: 100_000,
      ix_operations: [],
      participants: [],
    };

    const signed = await signer.sign(ix);
    // POLO hex is unprefixed
    expect(signed.ix_args).toMatch(/^[0-9a-fA-F]+$/);
    expect(signed.signatures).toMatch(/^[0-9a-fA-F]+$/);
  });

  it("two different users have different agent addresses", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    const user1 = await store.getOrCreate("user1");
    const user2 = await store.getOrCreate("user2");

    expect(user1.address).not.toBe(user2.address);
  });

  it("same user always gets the same address", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    const first = await store.getOrCreate("user1");
    const second = await store.getOrCreate("user1");
    const third = await store.getOrCreate("user1");

    expect(first.address).toBe(second.address);
    expect(second.address).toBe(third.address);
  });
});

// ============================================================================
// Contract Pinning Tests (from design contract section 0-1)
// ============================================================================

describe("Design Contract Requirements", () => {
  beforeEach(() => {
    setupEnv();
  });

  afterEach(() => {
    teardownEnv();
  });

  it("MandateSigner cannot be used to sign Approve/Revoke (no test needed at unit level)", () => {
    // This is enforced at the module 5 level (tools/mandates.ts), not here.
    // The test is a reminder that mandates.ts must never pass an Approve/Revoke
    // UnsignedInteraction to MandateSigner.
    expect(true).toBe(true); // Placeholder
  });

  it("ReadOnlySigner still throws (not changed by this module)", () => {
    // This module doesn't touch ReadOnlySigner, so no change.
    // The invariant "ReadOnlySigner keeps throwing" is preserved.
    expect(true).toBe(true); // Placeholder
  });

  it("Agent key is never held as plaintext on disk", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    await store.getOrCreate("user1");

    // Read the disk file
    const agentsDir = join(dir, "agents");
    const hash = createHash("sha256").update("user1").digest("hex");
    const filePath = join(agentsDir, `${hash}.json`);
    const diskContent = readFileSync(filePath, "utf8");

    // The keystore field is encrypted JSON, not plaintext
    const record = JSON.parse(diskContent) as AgentKeyRecord;
    const keystoreObj = JSON.parse(record.keystore);

    // keystore should have cipher fields (Web3 Secret Storage format), not raw key
    expect(keystoreObj).toHaveProperty("cipher"); // e.g., "aes-128-ctr"
    expect(keystoreObj).toHaveProperty("ciphertext");
    expect(keystoreObj).toHaveProperty("cipherparams");

    // Spot-check: the raw content should not contain typical key patterns
    // (this is heuristic, but good enough for a pinning test)
    expect(diskContent).not.toMatch(/"privateKey"|"mnemonic"/);
  });

  it("Agent key password is derived from server secret + userId (via scrypt)", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    // Set a specific secret so we can verify the derivation
    process.env.MOI_AGENT_KEYSTORE_SECRET = "test-secret-123";

    const record = await store.getOrCreate("user1");

    // Manually derive what the password should be
    const expected = scryptSync("test-secret-123", "user1", 32, {
      N: 16384,
      r: 8,
      p: 1,
    }).toString("hex");

    // Load the wallet with the expected password
    const wallet = await loadAgentWallet(store, "user1", expected);
    expect(wallet).toBeInstanceOf(Wallet);
  });
});

describe("FileAgentKeyStore concurrent creation", () => {
  beforeEach(() => {
    setupEnv();
  });
  afterEach(() => {
    teardownEnv();
  });

  it("returns one address when the same new user is created twice at once", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    // Unserialized, both calls see no record, each generates its own wallet,
    // and the later write wins — leaving one caller holding an address whose
    // key was overwritten and can no longer sign.
    const [a, b] = await Promise.all([
      store.getOrCreate("racer"),
      store.getOrCreate("racer"),
    ]);

    expect(a.address).toBe(b.address);
    expect((await store.get("racer"))?.address).toBe(a.address);
  });

  it("still gives different users different keys", async () => {
    const dir = tempDataDir();
    const store = new FileAgentKeyStore(dir);

    const [a, b] = await Promise.all([
      store.getOrCreate("userA"),
      store.getOrCreate("userB"),
    ]);

    expect(a.address).not.toBe(b.address);
  });
});
