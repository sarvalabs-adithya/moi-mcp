/**
 * Mandate ledger: tracks spend caps and expiries by replaying the journal.
 *
 * Three new journal `kind` values:
 *   - mandate_grant: owner approves agent to spend up to X by expiry Y
 *   - mandate_revoke: owner revokes the mandate
 *   - mandate_spend: agent spends under the mandate (reserves + commits)
 *
 * Reduction rule: only entries at or after the most recent mandate_grant count.
 * A mandate_revoke zeroes remaining; mandate_spend entries in state proposed/confirmed count toward spent.
 * Amounts are stored as decimal strings in the journal to preserve bigint precision.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WriteJournal, type JournalEntry } from "../journal.js";
import { MoiError } from "../moi-error.js";
import { ErrorCode } from "../schema.js";

export interface MandateKey {
  userId: string;
  assetId: string;
  benefactor: string;   // owner
  beneficiary: string;  // agent
}

export interface MandateRecord {
  found: boolean;
  cap: bigint;
  spent: bigint;
  remaining: bigint;
  expiresAt: number;
  active: boolean;
}

/**
 * Persists mandate state by replaying the journal.
 * The journal is the single source of truth; no separate mandate store.
 */
export class MandateLedger {
  private journalPath: string;

  constructor(private readonly journal: WriteJournal, dataDir: string) {
    this.journalPath = join(dataDir, "journal.jsonl");
  }

  /**
   * Returns the current state of a mandate by replaying all journal entries.
   * Never throws — returns found:false if no grant exists.
   */
  async get(key: MandateKey): Promise<MandateRecord> {
    const allEntries = this.readAllJournalEntries();
    const mandateEntries = allEntries.filter((e) => this.matchesKey(e, key));

    // Find the most recent mandate_grant
    let mostRecentGrant: JournalEntry | undefined;
    for (let i = mandateEntries.length - 1; i >= 0; i--) {
      const e = mandateEntries[i];
      if (e && e.kind === "mandate_grant") {
        mostRecentGrant = e;
        break;
      }
    }

    if (!mostRecentGrant) {
      return {
        found: false,
        cap: 0n,
        spent: 0n,
        remaining: 0n,
        expiresAt: 0,
        active: false,
      };
    }

    // Parse grant data
    const grantDetail = JSON.parse(mostRecentGrant.detail || "{}");
    const cap = BigInt(grantDetail.cap || "0");
    const expiresAt = grantDetail.expiresAt || 0;

    // Entries at or after the most recent grant (by timestamp)
    const grantTime = new Date(mostRecentGrant.timestamp).getTime();
    const afterGrant = mandateEntries.filter(
      (e) => new Date(e.timestamp).getTime() >= grantTime
    );

    // Check for revoke after grant
    let revoked = false;
    for (const e of afterGrant) {
      if (e.kind === "mandate_revoke") {
        revoked = true;
        break;
      }
    }

    // Sum spends (proposed or confirmed only)
    let spent = 0n;
    for (const e of afterGrant) {
      if (e.kind === "mandate_spend") {
        // Get the latest state for this entry id across ALL entries
        const lastEntryState = this.getLatestEntryState(allEntries, e.id);
        if (lastEntryState && (lastEntryState.state === "proposed" || lastEntryState.state === "confirmed")) {
          const spendDetail = JSON.parse(e.detail || "{}");
          spent += BigInt(spendDetail.amount || "0");
        }
      }
    }

    const remaining = revoked ? 0n : cap - spent;

    return {
      found: true,
      cap,
      spent,
      remaining: remaining < 0n ? 0n : remaining,
      expiresAt,
      active: !revoked && Date.now() / 1000 < expiresAt && remaining > 0n,
    };
  }

  /**
   * Records a mandate grant (absolute-set semantics).
   * Replaces any prior cap/expiry for this key.
   */
  async recordGrant(key: MandateKey, cap: bigint, expiresAt: number): Promise<{ journalEntryId: string }> {
    const id = this.makeEntryId("mandate_grant", key);
    const detail = JSON.stringify({
      assetId: key.assetId,
      benefactor: key.benefactor,
      beneficiary: key.beneficiary,
      cap: cap.toString(),
      expiresAt,
    });

    await this.journal.append({
      id,
      userId: key.userId,
      kind: "mandate_grant",
      state: "proposed",
      detail,
    });

    return { journalEntryId: id };
  }

  /**
   * Records a mandate revoke.
   */
  async recordRevoke(key: MandateKey): Promise<{ journalEntryId: string }> {
    const id = this.makeEntryId("mandate_revoke", key);
    const detail = JSON.stringify({
      assetId: key.assetId,
      benefactor: key.benefactor,
      beneficiary: key.beneficiary,
    });

    await this.journal.append({
      id,
      userId: key.userId,
      kind: "mandate_revoke",
      state: "proposed",
      detail,
    });

    return { journalEntryId: id };
  }

  /**
   * Server-side gate: reserve spend against the mandate.
   * Throws MANDATE_NOT_FOUND / MANDATE_EXPIRED / MANDATE_EXCEEDED.
   * Synchronously appends a proposed mandate_spend journal entry — the reservation itself.
   */
  async reserve(key: MandateKey, amount: bigint): Promise<{ journalEntryId: string; remainingAfter: bigint }> {
    const record = await this.get(key);

    if (!record.found) {
      throw new MoiError(ErrorCode.MANDATE_NOT_FOUND, "Mandate not found", {
        userId: key.userId,
        assetId: key.assetId,
        benefactor: key.benefactor,
        beneficiary: key.beneficiary,
      });
    }

    const now = Date.now() / 1000;
    if (now >= record.expiresAt) {
      throw new MoiError(ErrorCode.MANDATE_EXPIRED, "Mandate has expired", {
        expiresAt: record.expiresAt,
        now: Math.floor(now),
        remaining: record.remaining.toString(),
      });
    }

    if (amount > record.remaining) {
      throw new MoiError(ErrorCode.MANDATE_EXCEEDED, "Spend amount exceeds mandate cap", {
        amount: amount.toString(),
        remaining: record.remaining.toString(),
        cap: record.cap.toString(),
      });
    }

    // Synchronously append the reservation
    const id = this.makeEntryId("mandate_spend", key, Date.now().toString());
    const detail = JSON.stringify({
      assetId: key.assetId,
      benefactor: key.benefactor,
      beneficiary: key.beneficiary,
      amount: amount.toString(),
    });

    await this.journal.append({
      id,
      userId: key.userId,
      kind: "mandate_spend",
      state: "proposed",
      detail,
    });

    const remainingAfter = record.remaining - amount;

    return { journalEntryId: id, remainingAfter };
  }

  /**
   * Marks a reserved spend as committed (moves from proposed to confirmed).
   * No-op on the arithmetic — the proposed entry already counted.
   */
  async commit(journalEntryId: string): Promise<void> {
    await this.journal.update(journalEntryId, "confirmed");
  }

  /**
   * Marks a reserved spend as released (failed/orphaned).
   * Removes it from the spent count on next replay.
   */
  async release(journalEntryId: string): Promise<void> {
    await this.journal.update(journalEntryId, "orphaned");
  }

  /**
   * Read all entries from the journal (not just pending).
   * Needed for reduction: we must see the full history to find the latest grant timestamp.
   * Mirrors WriteJournal's private readAll implementation.
   */
  private readAllJournalEntries(): JournalEntry[] {
    if (!existsSync(this.journalPath)) {
      return [];
    }

    try {
      const content = readFileSync(this.journalPath, "utf8");
      const lines = content.split("\n");
      const entries: JournalEntry[] = [];

      for (const line of lines) {
        const trimmed = (line || "").trim();
        if (!trimmed) continue;

        try {
          const data = JSON.parse(trimmed);
          entries.push(data as JournalEntry);
        } catch {
          // Skip invalid lines
        }
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Matches an entry to a mandate key.
   */
  private matchesKey(entry: JournalEntry, key: MandateKey): boolean {
    if (entry.userId !== key.userId) return false;
    if (entry.kind !== "mandate_grant" && entry.kind !== "mandate_revoke" && entry.kind !== "mandate_spend") {
      return false;
    }

    const detail = JSON.parse(entry.detail || "{}");
    return (
      detail.assetId === key.assetId &&
      detail.benefactor === key.benefactor &&
      detail.beneficiary === key.beneficiary
    );
  }

  /**
   * Gets the latest state for a given entry id.
   */
  private getLatestEntryState(entries: JournalEntry[], id: string): JournalEntry | undefined {
    let latest: JournalEntry | undefined;
    for (const e of entries) {
      if (e.id === id) {
        latest = e;
      }
    }
    return latest;
  }

  /**
   * Creates a deterministic entry id for mandate records.
   * Includes timestamp when needed to ensure uniqueness within the same second.
   */
  private makeEntryId(kind: string, key: MandateKey, suffix?: string): string {
    const base = `${kind}:${key.userId}:${key.assetId}:${key.benefactor}:${key.beneficiary}`;
    if (suffix) return `${base}:${suffix}`;
    return base;
  }
}

// Re-export for convenience
export { MoiError };
