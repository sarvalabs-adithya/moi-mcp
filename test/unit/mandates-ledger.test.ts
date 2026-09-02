import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { WriteJournal } from "../../src/journal.js";
import { MandateLedger, type MandateKey } from "../../src/mandates/ledger.js";
import { ErrorCode } from "../../src/schema.js";
import { MoiError } from "../../src/moi-error.js";

const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-ledger-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

const defaultKey: MandateKey = {
  userId: "user1",
  assetId: "0xasset123",
  benefactor: "0xowner",
  beneficiary: "0xagent",
};

/**
 * recordGrant() only journals a "proposed" grant — it never authorizes
 * anything on-chain by itself. A mandate only becomes found/active once the
 * owner's Approve interaction is signed and broadcast, which lands here as
 * ledger.commit(journalEntryId). Most tests below only care about the
 * post-confirmation state, so they go through this helper; the tests that
 * specifically exercise the "not yet confirmed" gate call recordGrant()
 * directly instead.
 */
async function grantAndConfirm(
  ledger: MandateLedger,
  key: MandateKey,
  cap: bigint,
  expiresAt: number,
): Promise<{ journalEntryId: string }> {
  const result = await ledger.recordGrant(key, cap, expiresAt);
  await ledger.commit(result.journalEntryId);
  return result;
}

describe("MandateLedger", () => {
  describe("get", () => {
    it("returns found:false for nonexistent mandate", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const record = await ledger.get(defaultKey);

      expect(record.found).toBe(false);
      expect(record.cap).toBe(0n);
      expect(record.spent).toBe(0n);
      expect(record.remaining).toBe(0n);
      expect(record.active).toBe(false);
    });

    it("returns found:true after a grant is confirmed", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
      await grantAndConfirm(ledger, defaultKey, 1000n, expiresAt);

      const record = await ledger.get(defaultKey);

      expect(record.found).toBe(true);
      expect(record.cap).toBe(1000n);
      expect(record.spent).toBe(0n);
      expect(record.remaining).toBe(1000n);
      expect(record.expiresAt).toBe(expiresAt);
      expect(record.active).toBe(true);
    });

    it("does not report an unconfirmed (still-proposed) grant as found or active", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      // The owner has not yet approved this on their wallet — no commit().
      await ledger.recordGrant(defaultKey, 1000n, expiresAt);

      const record = await ledger.get(defaultKey);

      expect(record.found).toBe(false);
      expect(record.active).toBe(false);
      expect(record.cap).toBe(0n);
      expect(record.remaining).toBe(0n);
    });

    it("skips a newer unconfirmed grant attempt and falls back to an older confirmed one", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt);

      await new Promise((r) => setTimeout(r, 10));
      // A replacement grant is proposed but never confirmed (broadcast failed,
      // or approval is still pending on the phone).
      await ledger.recordGrant(defaultKey, 500n, expiresAt);

      const record = await ledger.get(defaultKey);

      expect(record.found).toBe(true);
      expect(record.cap).toBe(100n);
      expect(record.active).toBe(true);
    });

    it("marks mandate inactive after expiry", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) - 1; // 1 second ago
      await grantAndConfirm(ledger, defaultKey, 1000n, expiresAt);

      const record = await ledger.get(defaultKey);

      expect(record.found).toBe(true);
      expect(record.active).toBe(false);
    });

    it("tracks spent amount from spends", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 1000n, expiresAt);

      // Manually add spends to the journal
      await ledger.reserve(defaultKey, 300n);
      await ledger.reserve(defaultKey, 200n);

      const record = await ledger.get(defaultKey);

      expect(record.spent).toBe(500n);
      expect(record.remaining).toBe(500n);
    });

    it("revoke zeroes remaining", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 1000n, expiresAt);
      await ledger.recordRevoke(defaultKey);

      const record = await ledger.get(defaultKey);

      expect(record.remaining).toBe(0n);
      expect(record.active).toBe(false);
    });

    it("allows bigint amounts > 2^53", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const bigAmount = BigInt("9999999999999999999"); // > 2^53
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, bigAmount, expiresAt);

      const record = await ledger.get(defaultKey);

      expect(record.cap).toBe(bigAmount);
      expect(record.spent).toBe(0n);
      expect(record.remaining).toBe(bigAmount);
    });

    it("only considers entries after most recent grant", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt1 = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt1);

      // Add spend (before replacement)
      await ledger.reserve(defaultKey, 50n);

      // Wait a tiny bit and replace grant
      await new Promise((r) => setTimeout(r, 10));
      const expiresAt2 = Math.floor(Date.now() / 1000) + 7200;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt2);

      const record = await ledger.get(defaultKey);

      // Spend from first grant should not count
      expect(record.cap).toBe(500n);
      expect(record.spent).toBe(0n);
      expect(record.remaining).toBe(500n);
    });

    it("handles negative remaining (when overdrawn) by flooring to 0", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      // Manually create journal entries to simulate an overdrawn state
      // (This shouldn't happen in practice due to reserve() checks, but defensive)
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt);

      // Simulate an orphaned spend that shouldn't count
      const spendId = await ledger.reserve(defaultKey, 50n);
      await ledger.release(spendId.journalEntryId); // Release it

      const record = await ledger.get(defaultKey);
      expect(record.spent).toBe(0n); // Orphaned spend doesn't count
      expect(record.remaining).toBe(100n);
    });
  });

  describe("recordGrant", () => {
    it("appends grant to journal with absolute-set semantics", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const result = await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      expect(result.journalEntryId).toMatch(/^mandate_grant:/);

      const record = await ledger.get(defaultKey);
      expect(record.cap).toBe(500n);
      expect(record.expiresAt).toBe(expiresAt);
    });

    it("replaces prior cap on second grant", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt1 = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt1);

      // Wait and grant again
      await new Promise((r) => setTimeout(r, 10));
      const expiresAt2 = Math.floor(Date.now() / 1000) + 7200;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt2);

      const record = await ledger.get(defaultKey);

      expect(record.cap).toBe(500n);
      expect(record.expiresAt).toBe(expiresAt2);
    });

    it("stores grant in journal with decimal string amount", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const bigAmount = BigInt("12345678901234567890");
      await ledger.recordGrant(defaultKey, bigAmount, expiresAt);

      // Read journal directly to verify encoding
      const journalPath = join(dir, "journal.jsonl");
      const content = readFileSync(journalPath, "utf8");
      const entry = JSON.parse(content.trim());

      expect(entry.detail).toBeDefined();
      const detail = JSON.parse(entry.detail);
      expect(detail.cap).toBe(bigAmount.toString());
      expect(typeof detail.cap).toBe("string");
    });

    it("gives each grant attempt a unique journal entry id", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const first = await ledger.recordGrant(defaultKey, 100n, expiresAt);
      const second = await ledger.recordGrant(defaultKey, 500n, expiresAt);

      // A collision here would mean a later commit()/release() of one
      // attempt (once the grant-approval signAndBroadcast seam is wired)
      // could silently confirm or release the wrong one.
      expect(first.journalEntryId).not.toBe(second.journalEntryId);
      expect(first.journalEntryId).toMatch(/^mandate_grant:/);
      expect(second.journalEntryId).toMatch(/^mandate_grant:/);
    });
  });

  describe("recordRevoke", () => {
    it("appends revoke to journal", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const result = await ledger.recordRevoke(defaultKey);
      expect(result.journalEntryId).toMatch(/^mandate_revoke:/);

      const record = await ledger.get(defaultKey);
      expect(record.active).toBe(false);
      expect(record.remaining).toBe(0n);
    });

    it("revoke zeroes remaining even before expiry", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);
      await ledger.reserve(defaultKey, 100n);
      await ledger.recordRevoke(defaultKey);

      const record = await ledger.get(defaultKey);

      expect(record.found).toBe(true);
      expect(record.remaining).toBe(0n);
      expect(record.active).toBe(false);
    });
  });

  describe("reserve", () => {
    it("throws MANDATE_NOT_FOUND for nonexistent mandate", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      await expect(ledger.reserve(defaultKey, 100n)).rejects.toThrow(MoiError);
      try {
        await ledger.reserve(defaultKey, 100n);
      } catch (err) {
        if (err instanceof MoiError) {
          expect(err.code).toBe(ErrorCode.MANDATE_NOT_FOUND);
        }
      }
    });

    it("throws MANDATE_NOT_FOUND when the grant was journaled but never confirmed", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      // Never confirmed — the owner never actually approved this on-chain.
      await ledger.recordGrant(defaultKey, 500n, expiresAt);

      await expect(ledger.reserve(defaultKey, 100n)).rejects.toThrow(MoiError);
      try {
        await ledger.reserve(defaultKey, 100n);
      } catch (err) {
        if (err instanceof MoiError) {
          expect(err.code).toBe(ErrorCode.MANDATE_NOT_FOUND);
        }
      }
    });

    it("throws MANDATE_EXPIRED for expired mandate", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) - 1;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      await expect(ledger.reserve(defaultKey, 100n)).rejects.toThrow(MoiError);
      try {
        await ledger.reserve(defaultKey, 100n);
      } catch (err) {
        if (err instanceof MoiError) {
          expect(err.code).toBe(ErrorCode.MANDATE_EXPIRED);
        }
      }
    });

    it("throws MANDATE_EXCEEDED when amount > remaining", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt);

      await expect(ledger.reserve(defaultKey, 150n)).rejects.toThrow(MoiError);
      try {
        await ledger.reserve(defaultKey, 150n);
      } catch (err) {
        if (err instanceof MoiError) {
          expect(err.code).toBe(ErrorCode.MANDATE_EXCEEDED);
          expect(err.data.remaining).toBe("100");
        }
      }
    });

    it("appends spend to journal and returns journalEntryId", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const result = await ledger.reserve(defaultKey, 100n);

      expect(result.journalEntryId).toMatch(/^mandate_spend:/);
      expect(result.remainingAfter).toBe(400n);
    });

    it("decrements remaining correctly", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 1000n, expiresAt);

      const r1 = await ledger.reserve(defaultKey, 300n);
      expect(r1.remainingAfter).toBe(700n);

      const r2 = await ledger.reserve(defaultKey, 200n);
      expect(r2.remainingAfter).toBe(500n);
    });

    it("fails on second reserve when total > cap (TOCTOU close)", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt);

      await ledger.reserve(defaultKey, 60n);

      // Second reserve should fail because 50n > remaining 40n
      await expect(ledger.reserve(defaultKey, 50n)).rejects.toThrow(MoiError);
      try {
        await ledger.reserve(defaultKey, 50n);
      } catch (err) {
        if (err instanceof MoiError) {
          expect(err.code).toBe(ErrorCode.MANDATE_EXCEEDED);
          expect(err.data.remaining).toBe("40");
        }
      }
    });

    it("serializes concurrent reserve() calls so the cap cannot be oversold", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt);

      // Two concurrent reserves that would jointly overspend the 100n cap
      // (60 + 60 = 120) if both raced past the same pre-reservation read.
      const results = await Promise.allSettled([
        ledger.reserve(defaultKey, 60n),
        ledger.reserve(defaultKey, 60n),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const record = await ledger.get(defaultKey);
      expect(record.spent).toBe(60n);
      expect(record.remaining).toBe(40n);
    });

    it("does not serialize reserve() calls for different mandate keys", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const keyA = { ...defaultKey, beneficiary: "0xagentA" };
      const keyB = { ...defaultKey, beneficiary: "0xagentB" };

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, keyA, 100n, expiresAt);
      await grantAndConfirm(ledger, keyB, 100n, expiresAt);

      const [resultA, resultB] = await Promise.all([
        ledger.reserve(keyA, 60n),
        ledger.reserve(keyB, 60n),
      ]);

      expect(resultA.remainingAfter).toBe(40n);
      expect(resultB.remainingAfter).toBe(40n);
    });

    it("does not append journal entry on error", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 100n, expiresAt);

      const journalPath = join(dir, "journal.jsonl");

      // Get initial line count
      let content = readFileSync(journalPath, "utf8");
      const initialLines = content.split("\n").filter((l) => l.trim()).length;

      // Try reserve that will fail
      try {
        await ledger.reserve(defaultKey, 150n);
      } catch {
        // Expected
      }

      // Verify no new entry was added
      content = readFileSync(journalPath, "utf8");
      const afterLines = content.split("\n").filter((l) => l.trim()).length;
      expect(afterLines).toBe(initialLines);
    });

    it("stores spend amount as decimal string", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const bigAmount = BigInt("12345678901234567890");
      await grantAndConfirm(ledger, defaultKey, bigAmount, expiresAt);

      await ledger.reserve(defaultKey, 500n);

      const journalPath = join(dir, "journal.jsonl");
      const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim());
      const lastEntry = JSON.parse(lines[lines.length - 1]!);

      expect(lastEntry.kind).toBe("mandate_spend");
      const detail = JSON.parse(lastEntry.detail);
      expect(detail.amount).toBe("500");
      expect(typeof detail.amount).toBe("string");
    });
  });

  describe("commit", () => {
    it("updates entry state to confirmed", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const r = await ledger.reserve(defaultKey, 100n);
      await ledger.commit(r.journalEntryId);

      // Verify state via journal read
      const journalPath = join(dir, "journal.jsonl");
      const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim());
      const lastEntry = JSON.parse(lines[lines.length - 1]!);

      expect(lastEntry.state).toBe("confirmed");
    });

    it("does not change spent count (already counted as proposed)", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const r = await ledger.reserve(defaultKey, 100n);

      const beforeCommit = await ledger.get(defaultKey);
      expect(beforeCommit.spent).toBe(100n);
      expect(beforeCommit.remaining).toBe(400n);

      await ledger.commit(r.journalEntryId);

      const afterCommit = await ledger.get(defaultKey);
      expect(afterCommit.spent).toBe(100n);
      expect(afterCommit.remaining).toBe(400n);
    });

    it("makes a mandate_grant entry found/active once confirmed", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const grant = await ledger.recordGrant(defaultKey, 500n, expiresAt);

      const beforeCommit = await ledger.get(defaultKey);
      expect(beforeCommit.found).toBe(false);
      expect(beforeCommit.active).toBe(false);

      await ledger.commit(grant.journalEntryId);

      const afterCommit = await ledger.get(defaultKey);
      expect(afterCommit.found).toBe(true);
      expect(afterCommit.active).toBe(true);
      expect(afterCommit.cap).toBe(500n);
    });
  });

  describe("release", () => {
    it("updates entry state to orphaned", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const r = await ledger.reserve(defaultKey, 100n);
      await ledger.release(r.journalEntryId);

      const journalPath = join(dir, "journal.jsonl");
      const lines = readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim());
      const lastEntry = JSON.parse(lines[lines.length - 1]!);

      expect(lastEntry.state).toBe("orphaned");
    });

    it("removes released spend from spent count", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const r = await ledger.reserve(defaultKey, 100n);

      const beforeRelease = await ledger.get(defaultKey);
      expect(beforeRelease.spent).toBe(100n);
      expect(beforeRelease.remaining).toBe(400n);

      await ledger.release(r.journalEntryId);

      const afterRelease = await ledger.get(defaultKey);
      expect(afterRelease.spent).toBe(0n);
      expect(afterRelease.remaining).toBe(500n);
    });

    it("allows re-reserve after release", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);

      const r1 = await ledger.reserve(defaultKey, 100n);
      await ledger.release(r1.journalEntryId);

      // Should now be able to reserve the 100n again
      const r2 = await ledger.reserve(defaultKey, 100n);
      expect(r2.remainingAfter).toBe(400n);
    });

    it("a grant that failed to broadcast (released) stays inactive", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const grant = await ledger.recordGrant(defaultKey, 500n, expiresAt);
      await ledger.release(grant.journalEntryId);

      const record = await ledger.get(defaultKey);
      expect(record.found).toBe(false);
      expect(record.active).toBe(false);
    });
  });

  describe("reconcileOnBoot integration", () => {
    it("survives journal crash mid-spend (orphaned proposed entry)", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);
      await ledger.reserve(defaultKey, 100n);

      // Simulate crash: entry is still proposed
      // On replay, it should still count as spent

      const record = await ledger.get(defaultKey);
      expect(record.spent).toBe(100n);
      expect(record.remaining).toBe(400n);
    });

    it("handles committed spend across restart", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);
      const r = await ledger.reserve(defaultKey, 100n);
      await ledger.commit(r.journalEntryId);

      // Simulate restart: new ledger instance
      const ledger2 = new MandateLedger(new WriteJournal(dir), dir);

      const record = await ledger2.get(defaultKey);
      expect(record.spent).toBe(100n);
      expect(record.remaining).toBe(400n);
    });

    it("handles released spend across restart", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 500n, expiresAt);
      const r = await ledger.reserve(defaultKey, 100n);
      await ledger.release(r.journalEntryId);

      // Simulate restart
      const ledger2 = new MandateLedger(new WriteJournal(dir), dir);

      const record = await ledger2.get(defaultKey);
      expect(record.spent).toBe(0n);
      expect(record.remaining).toBe(500n);
    });
  });

  describe("edge cases", () => {
    it("handles zero cap", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, 0n, expiresAt);

      const record = await ledger.get(defaultKey);
      expect(record.cap).toBe(0n);
      expect(record.remaining).toBe(0n);

      // Reserve should fail
      await expect(ledger.reserve(defaultKey, 1n)).rejects.toThrow();
    });

    it("handles max amount in bigint range", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const maxAmount = BigInt("9".repeat(78)); // Very large bigint
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, defaultKey, maxAmount, expiresAt);

      const record = await ledger.get(defaultKey);
      expect(record.cap).toBe(maxAmount);
      expect(record.remaining).toBe(maxAmount);
    });

    it("handles multiple mandates for same user/asset but different beneficiaries", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const key1 = { ...defaultKey, beneficiary: "0xagent1" };
      const key2 = { ...defaultKey, beneficiary: "0xagent2" };

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, key1, 100n, expiresAt);
      await grantAndConfirm(ledger, key2, 200n, expiresAt);

      const r1 = await ledger.get(key1);
      const r2 = await ledger.get(key2);

      expect(r1.cap).toBe(100n);
      expect(r2.cap).toBe(200n);
    });

    it("handles multiple mandates for different users", async () => {
      const dir = tempDataDir();
      const journal = new WriteJournal(dir);
      const ledger = new MandateLedger(journal, dir);

      const key1 = { ...defaultKey, userId: "user1" };
      const key2 = { ...defaultKey, userId: "user2" };

      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      await grantAndConfirm(ledger, key1, 100n, expiresAt);
      await grantAndConfirm(ledger, key2, 200n, expiresAt);

      const r1 = await ledger.get(key1);
      const r2 = await ledger.get(key2);

      expect(r1.cap).toBe(100n);
      expect(r2.cap).toBe(200n);
    });
  });
});
