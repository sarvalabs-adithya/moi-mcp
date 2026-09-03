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
/**
 * Spend states that hand capacity back to the cap. Everything else counts.
 */
const RELEASED_STATES = new Set<string>(["orphaned", "failed"]);

export class MandateLedger {
  private journalPath: string;

  /**
   * Per-key serialization for reserve(). Each entry is the tail of an
   * in-process queue of pending operations for that MandateKey; a new
   * operation chains onto it so "check remaining, then append" runs as one
   * unit relative to any other operation on the same key. Keyed by the same
   * (userId, assetId, benefactor, beneficiary) tuple reserve() gates on.
   * Process-local only — matches the single-process hosted server this runs in.
   */
  private readonly reserveQueues = new Map<string, Promise<unknown>>();

  /**
   * Monotonic counter mixed into grant entry ids alongside Date.now(). Two
   * recordGrant() calls issued back-to-back (no meaningful clock tick
   * between them, e.g. in a fast test or a tight retry) would otherwise
   * still collide on a millisecond-resolution timestamp alone.
   */
  private grantSeq = 0;
  private spendSeq = 0;

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

    // Find the most recent mandate_grant whose journal entry has actually
    // transitioned to "confirmed" — i.e., the owner's Approve interaction was
    // signed and successfully broadcast. A "proposed" grant is just a built,
    // simulated, journaled interaction the caller has not yet approved on
    // their wallet; it authorizes nothing on-chain, so it must not be
    // reported as found/active. This mirrors the state gate mandate_spend
    // entries already get below. A newer grant attempt that never confirmed
    // (e.g. still awaiting approval, or the broadcast failed) is skipped in
    // favor of an older confirmed one, rather than blanking the mandate out.
    let mostRecentGrant: JournalEntry | undefined;
    for (let i = mandateEntries.length - 1; i >= 0; i--) {
      const e = mandateEntries[i];
      if (e && e.kind === "mandate_grant") {
        const latestState = this.getLatestEntryState(allEntries, e.id);
        if (latestState && latestState.state === "confirmed") {
          mostRecentGrant = e;
          break;
        }
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
        // Fail closed: a spend counts against the cap unless it was explicitly
        // given back ("orphaned"/"failed"). Listing the counted states instead
        // would silently free cap for any state nobody remembered to add —
        // including "broadcast", which is precisely the one we cannot prove
        // never landed.
        if (lastEntryState && !RELEASED_STATES.has(lastEntryState.state)) {
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
   *
   * Each call gets a unique journal entry id (a Date.now() suffix, same
   * scheme reserve() uses for mandate_spend) rather than the bare
   * deterministic key. Without that, two grant attempts for the same
   * (userId, assetId, benefactor, beneficiary) — e.g. a replacement grant
   * made while an earlier one is still awaiting wallet approval — would
   * collide on id, so a later commit(journalEntryId) call (once the
   * signAndBroadcast seam for grants is wired) could confirm the wrong
   * attempt.
   */
  async recordGrant(key: MandateKey, cap: bigint, expiresAt: number): Promise<{ journalEntryId: string }> {
    const id = this.makeEntryId("mandate_grant", key, `${Date.now()}-${this.grantSeq++}`);
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
   *
   * The read-check-then-append below is not atomic on its own — get() reads
   * and journal.append() writes are two separate async steps with a real
   * yield point between them (get() resolves via a microtask before its
   * result is checked). Two overlapping reserve() calls for the same key
   * could otherwise both read the same pre-reservation `remaining`, both
   * pass the cap check, and both append — jointly overspending the cap. This
   * serializes reserve() per MandateKey via an in-process queue so the whole
   * check-then-append body runs as one unit relative to other reserve()
   * calls on the same key; calls for different keys still run concurrently.
   */
  async reserve(key: MandateKey, amount: bigint): Promise<{ journalEntryId: string; remainingAfter: bigint }> {
    return this.withReserveLock(key, () => this.reserveLocked(key, amount));
  }

  private async reserveLocked(
    key: MandateKey,
    amount: bigint,
  ): Promise<{ journalEntryId: string; remainingAfter: bigint }> {
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
    // Same reason grants carry a counter: two reserves for one key inside a single
    // millisecond would otherwise share an id, and a later commit/release of one
    // would silently retarget the other.
    const id = this.makeEntryId("mandate_spend", key, `${Date.now()}-${this.spendSeq++}`);
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
  async commit(journalEntryId: string, patch?: Record<string, unknown>): Promise<void> {
    await this.journal.update(journalEntryId, "confirmed", patch);
  }

  /**
   * Marks a reserved spend as released (failed/orphaned).
   * Removes it from the spent count on next replay.
   */
  async release(journalEntryId: string): Promise<void> {
    await this.journal.update(journalEntryId, "orphaned");
  }

  /**
   * Records that a reserved spend is about to be signed and broadcast.
   *
   * This is what makes crash recovery decidable. A spend still sitting at
   * "proposed" provably never reached the network, so its capacity can be
   * given back. One at "broadcast" may or may not have landed, and we have
   * no way to tell from the journal alone — so it keeps counting.
   */
  async markBroadcasting(journalEntryId: string): Promise<void> {
    await this.journal.update(journalEntryId, "broadcast");
  }

  /**
   * Resolves spends stranded by a crash between reserve() and commit()/release().
   *
   * Releases only what provably never went out; anything that may have hit the
   * chain stays counted and is returned so the caller can surface it. Freeing a
   * spend that really happened would let the cap be spent twice, so the
   * asymmetry is deliberate.
   */
  async reconcileStranded(): Promise<{ released: string[]; held: StrandedSpend[] }> {
    const allEntries = this.readAllJournalEntries();
    const seen = new Set<string>();
    const released: string[] = [];
    const held: StrandedSpend[] = [];

    for (const e of allEntries) {
      if (e.kind !== "mandate_spend" || seen.has(e.id)) continue;
      seen.add(e.id);

      const latest = this.getLatestEntryState(allEntries, e.id);
      if (!latest || RELEASED_STATES.has(latest.state) || latest.state === "confirmed") continue;

      if (latest.state === "proposed") {
        await this.release(e.id);
        released.push(e.id);
      } else {
        let amount = "unknown";
        try {
          amount = String(JSON.parse(e.detail || "{}").amount ?? "unknown");
        } catch {
          // detail is advisory here; an unparsable one must not abort recovery
        }
        held.push({ journalEntryId: e.id, userId: e.userId, state: latest.state, amount });
      }
    }

    return { released, held };
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
   * Runs `fn` after every previously-queued operation for this MandateKey has
   * settled, and only then — serializing reserve() per key without blocking
   * reserve() calls for other keys.
   *
   * Implementation: `reserveQueues` holds the tail promise of each key's
   * queue. Chaining a new operation on with `.then(fn, fn)` (not just
   * `.then(fn)`) means a prior operation's rejection (e.g. MANDATE_EXCEEDED)
   * does not wedge the queue for later callers. The tail stored back is that
   * same run, swallowed with `.catch()`, so the queue map itself never holds
   * a rejected promise.
   */
  private withReserveLock<T>(key: MandateKey, fn: () => Promise<T>): Promise<T> {
    const lockKey = this.reserveLockKey(key);
    const tail = this.reserveQueues.get(lockKey) ?? Promise.resolve();
    const run = tail.then(fn, fn);
    this.reserveQueues.set(
      lockKey,
      run.catch(() => undefined),
    );
    return run;
  }

  private reserveLockKey(key: MandateKey): string {
    return `${key.userId}:${key.assetId}:${key.benefactor}:${key.beneficiary}`;
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

/** A spend that may or may not have reached the chain; its cap stays held. */
export interface StrandedSpend {
  journalEntryId: string;
  userId: string;
  state: string;
  amount: string;
}

// Re-export for convenience
export { MoiError };
