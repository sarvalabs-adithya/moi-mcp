import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { WriteJournal } from "../../src/journal.js";
import type { WalletSessionStore, StoredWalletSession } from "../../src/wc/store.js";

const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-mandates-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Mock WalletSessionStore for testing.
 */
class MockWalletSessionStore implements WalletSessionStore {
  private sessions = new Map<string, StoredWalletSession>();

  async get(userId: string): Promise<StoredWalletSession | undefined> {
    return this.sessions.get(userId);
  }

  async set(record: StoredWalletSession): Promise<void> {
    this.sessions.set(record.userId, record);
  }

  async delete(userId: string): Promise<void> {
    this.sessions.delete(userId);
  }

  async findByTopic(topic: string): Promise<StoredWalletSession | undefined> {
    for (const session of this.sessions.values()) {
      if (session.topic === topic) return session;
    }
    return undefined;
  }

  async list(): Promise<StoredWalletSession[]> {
    return Array.from(this.sessions.values());
  }
}

describe("WriteJournal mandate entries", () => {
  let journal: WriteJournal;
  let dataDir: string;

  beforeEach(() => {
    dataDir = tempDataDir();
    journal = new WriteJournal(dataDir);
  });

  describe("mandate_grant journaling", () => {
    it("appends mandate_grant entries", async () => {
      const entry = {
        id: "test-mandate:user:asset:agent",
        userId: "test-user-123",
        kind: "mandate_grant",
        state: "proposed" as const,
        detail: JSON.stringify({ assetId: "0xabc", cap: "100", expiresAt: 12345 }),
      };

      await journal.append(entry);

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe(entry.id);
      expect(pending[0]!.kind).toBe("mandate_grant");
      expect(pending[0]!.state).toBe("proposed");
    });

    it("handles mandate_grant with cap and expiry in detail JSON", async () => {
      const cap = "1000000000";
      const expiresAt = Math.floor(Date.now() / 1000) + 86400 * 7; // 1 week from now

      const entry = {
        id: "mandate-entry-1",
        userId: "user-1",
        kind: "mandate_grant",
        state: "proposed" as const,
        detail: JSON.stringify({
          assetId: "0x1234",
          beneficiary: "0x5678",
          cap,
          expiresAt,
        }),
      };

      await journal.append(entry);

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);

      const detail = JSON.parse(pending[0]!.detail || "{}");
      expect(detail.cap).toBe(cap);
      expect(detail.expiresAt).toBe(expiresAt);
    });

    it("tracks mandate_grant state transitions", async () => {
      const id = "mandate-1";

      // Initial: proposed
      await journal.append({
        id,
        userId: "user-1",
        kind: "mandate_grant",
        state: "proposed",
        detail: JSON.stringify({ assetId: "0xabc", cap: "100" }),
      });

      // Transition: signed
      await journal.update(id, "signed");

      // Transition: broadcast
      await journal.update(id, "broadcast");

      // Final: confirmed (terminal)
      await journal.update(id, "confirmed");

      const pending = await journal.pending();
      expect(pending).toHaveLength(0); // Terminal state, not pending
    });

    it("can preserve detail through state transitions via patch", async () => {
      const id = "mandate-2";
      const detailData = { assetId: "0xdead", cap: "5000", expiresAt: 99999 };

      await journal.append({
        id,
        userId: "user-2",
        kind: "mandate_grant",
        state: "proposed",
        detail: JSON.stringify(detailData),
      });

      // Preserve detail by passing it in the patch
      await journal.update(id, "broadcast", { detail: JSON.stringify(detailData) });

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.detail).toBe(JSON.stringify(detailData));
    });
  });

  describe("mandate_revoke and mandate_spend entries", () => {
    it("appends mandate_revoke entries", async () => {
      const entry = {
        id: "revoke-mandate-1",
        userId: "user-1",
        kind: "mandate_revoke",
        state: "proposed" as const,
        detail: JSON.stringify({ assetId: "0xabc", beneficiary: "0x5678" }),
      };

      await journal.append(entry);

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.kind).toBe("mandate_revoke");
    });

    it("appends mandate_spend entries as proposed (reservation)", async () => {
      const entry = {
        id: "spend-mandate-1",
        userId: "user-1",
        kind: "mandate_spend",
        state: "proposed" as const,
        detail: JSON.stringify({ assetId: "0xabc", benefactor: "0x1111", beneficiary: "0x2222", amount: "100" }),
      };

      await journal.append(entry);

      const pending = await journal.pending();
      expect(pending).toHaveLength(1);
      expect(pending[0]!.kind).toBe("mandate_spend");
      expect(pending[0]!.state).toBe("proposed");
    });

    it("can release a reserved mandate_spend by marking it failed", async () => {
      const id = "spend-1";

      // Reserve
      await journal.append({
        id,
        userId: "user-1",
        kind: "mandate_spend",
        state: "proposed",
        detail: JSON.stringify({ amount: "50" }),
      });

      let pending = await journal.pending();
      expect(pending).toHaveLength(1);

      // Release (mark failed)
      await journal.update(id, "failed");

      pending = await journal.pending();
      expect(pending).toHaveLength(0); // Failed is terminal
    });

    it("can commit a reserved mandate_spend", async () => {
      const id = "spend-2";

      // Reserve as proposed
      await journal.append({
        id,
        userId: "user-1",
        kind: "mandate_spend",
        state: "proposed",
        detail: JSON.stringify({ amount: "75" }),
      });

      // Commit
      await journal.update(id, "confirmed");

      const pending = await journal.pending();
      expect(pending).toHaveLength(0); // Confirmed is terminal
    });
  });

  describe("mandate ledger semantics (journal-backed)", () => {
    it("can model a grant->spend->revoke sequence in the journal", async () => {
      const userId = "user-1";
      const assetId = "0x1234";
      const beneficiary = "0xagent";

      // Grant mandate
      const grantId = `mandate:${userId}:${assetId}:${beneficiary}`;
      await journal.append({
        id: grantId,
        userId,
        kind: "mandate_grant",
        state: "broadcast",
        detail: JSON.stringify({
          assetId,
          beneficiary,
          cap: "1000000",
          expiresAt: Math.floor(Date.now() / 1000) + 86400,
        }),
      });

      // Confirm the grant
      await journal.update(grantId, "confirmed");

      // Reserve a spend (mandate_spend with proposed state)
      const spendId = `spend:${userId}:${assetId}:${beneficiary}:1`;
      await journal.append({
        id: spendId,
        userId,
        kind: "mandate_spend",
        state: "proposed",
        detail: JSON.stringify({
          assetId,
          benefactor: "0xowner",
          beneficiary: "0xrecipient",
          amount: "100000",
        }),
      });

      // Confirm the spend
      await journal.update(spendId, "confirmed");

      // Revoke the mandate
      const revokeId = `revoke:${userId}:${assetId}:${beneficiary}`;
      await journal.append({
        id: revokeId,
        userId,
        kind: "mandate_revoke",
        state: "broadcast",
        detail: JSON.stringify({ assetId, beneficiary }),
      });

      await journal.update(revokeId, "confirmed");

      // Only spend entry is still pending (as an example, if it's broadcast but not confirmed)
      const pending = await journal.pending();
      // All are confirmed in this scenario, so no pending
      expect(pending).toHaveLength(0);
    });
  });
});
