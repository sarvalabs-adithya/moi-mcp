/**
 * Regressions for three ways the cap ledger could lose or duplicate money.
 *
 * Each of these was a live defect found by review, not a hypothetical: a spend
 * that reached the chain being handed back to the cap, two spends sharing a
 * journal id, and a crash mid-broadcast either freeing capacity it could not
 * account for or holding it forever with nobody told.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { WriteJournal } from "../../src/journal.js";
import { MandateLedger, type MandateKey } from "../../src/mandates/ledger.js";

const tempDirs: string[] = [];
function tempDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "moi-recovery-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key: MandateKey = {
  userId: "user1",
  assetId: "0xasset123",
  benefactor: "0xowner",
  beneficiary: "0xagent",
};

async function ledgerWithMandate(cap: bigint): Promise<{ ledger: MandateLedger; dir: string }> {
  const dir = tempDataDir();
  const ledger = new MandateLedger(new WriteJournal(dir), dir);
  const { journalEntryId } = await ledger.recordGrant(key, cap, Math.floor(Date.now() / 1000) + 3600);
  await ledger.commit(journalEntryId);
  return { ledger, dir };
}

describe("spend entry ids", () => {
  it("stay distinct for two reserves inside the same millisecond", async () => {
    const { ledger } = await ledgerWithMandate(1000n);

    // Same key, same tick. Sharing an id here would mean a later commit or
    // release of one silently retargeting the other.
    const [a, b] = await Promise.all([ledger.reserve(key, 100n), ledger.reserve(key, 100n)]);
    expect(a.journalEntryId).not.toBe(b.journalEntryId);

    // Confirming one must leave the other's capacity untouched.
    await ledger.commit(a.journalEntryId);
    expect((await ledger.get(key)).remaining).toBe(800n);

    await ledger.release(b.journalEntryId);
    expect((await ledger.get(key)).remaining).toBe(900n);
  });
});

describe("reconcileStranded", () => {
  it("gives back a spend that never reached the chain", async () => {
    const { ledger } = await ledgerWithMandate(1000n);
    const { journalEntryId } = await ledger.reserve(key, 250n);
    expect((await ledger.get(key)).remaining).toBe(750n);

    // Still "proposed": the process died before it tried to broadcast.
    const { released, held } = await ledger.reconcileStranded();
    expect(released).toEqual([journalEntryId]);
    expect(held).toEqual([]);
    expect((await ledger.get(key)).remaining).toBe(1000n);
  });

  it("keeps holding a spend that may have landed, and names it", async () => {
    const { ledger } = await ledgerWithMandate(1000n);
    const { journalEntryId } = await ledger.reserve(key, 250n);
    await ledger.markBroadcasting(journalEntryId);

    // We cannot prove this one never went out, so freeing it would risk
    // spending the same cap twice.
    const { released, held } = await ledger.reconcileStranded();
    expect(released).toEqual([]);
    expect(held).toHaveLength(1);
    expect(held[0]?.journalEntryId).toBe(journalEntryId);
    expect(held[0]?.amount).toBe("250");
    expect((await ledger.get(key)).remaining).toBe(750n);
  });

  it("leaves settled spends alone", async () => {
    const { ledger } = await ledgerWithMandate(1000n);
    const done = await ledger.reserve(key, 100n);
    await ledger.commit(done.journalEntryId);
    const gone = await ledger.reserve(key, 100n);
    await ledger.release(gone.journalEntryId);

    const { released, held } = await ledger.reconcileStranded();
    expect(released).toEqual([]);
    expect(held).toEqual([]);
    expect((await ledger.get(key)).remaining).toBe(900n);
  });
});

describe("cap accounting fails closed", () => {
  it("counts a mid-broadcast spend against the cap", async () => {
    const { ledger } = await ledgerWithMandate(1000n);
    const { journalEntryId } = await ledger.reserve(key, 400n);
    await ledger.markBroadcasting(journalEntryId);

    // "broadcast" is not a released state, so the capacity stays held.
    expect((await ledger.get(key)).remaining).toBe(600n);

    // And a second spend cannot exceed what is genuinely left.
    await expect(ledger.reserve(key, 700n)).rejects.toThrow();
  });
});
